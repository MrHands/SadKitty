const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();

// authentication

const auth = require('./auth.json');

// database

fs.exists('./storage.db', (exists) => {
	if (!exists) {
		let db = new sqlite3.Database('./storage.db', (_err) => {

			db.close();
		});
	}
});

// create or open database

let db = new sqlite3.Database('./storage.db');

db.run(`CREATE TABLE IF NOT EXISTS Author (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	url TEXT
)`);

db.run(`CREATE TABLE IF NOT EXISTS Post (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	author_id TEXT NOT NULL,
	url TEXT NOT NULL,
	description TEXT,
	timestamp TEXT,
	locked INTEGER,
	cache_media_count INTEGER
)`);

db.run(`CREATE TABLE IF NOT EXISTS Media (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	post_id INTEGER NOT NULL,
	url TEXT NOT NULL,
	file_path TEXT
)`);

// load authors

const authors = require('./authors.json');
db.serialize(() => {
	authors.forEach(author => {
		db.run(`INSERT OR IGNORE INTO Author (id, name, url) VALUES (?, ?, ?)`, [author.id, author.name, `https://onlyfans.com/${author.id}`]);
	});
});

// scraping

async function downloadMedia(url, index, author, post) {
	return new Promise((resolve, reject) => {
		// create directories

		const authorPath = `./downloads/${author.id}`;

		if (!fs.existsSync(authorPath)) {
			fs.mkdirSync(authorPath, { recursive: true });
		}

		// get path

		const encoded = new URL(url);
		const extension = encoded.pathname.split('.').pop();

		let fileName = post.description.replace(/[\\\/\:\*\?\"\<\>\| ]/g, '_');
		fileName = encodeURIComponent(fileName);

		if (index > 0) {
			fileName += `_(${index + 1})`;
		}

		let dstPath = authorPath + '/' + fileName + '.' + extension;

		// download file

		console.log(`Downloading to ${dstPath.split('/').pop()}...`);
	
		let file = fs.createWriteStream(dstPath);
	
		https.get(url, (response) => {
			response.pipe(file);
			resolve(dstPath);
		}).on('error', (err) => {
			fs.unlink(dstPath);
			console.log(`Failed to download: ${err.message}`);
			reject(err);
		});
	});
}

async function scrapePost(page, db, author, url) {
	console.log(`Scraping ${url}...`);

	await page.goto(url, {
		waitUntil: 'domcontentloaded',
	});

	await page.waitForSelector('.b-post__wrapper');

	let sources = [];

	let locked = 0;

	try {
		// check if locked

		const eleLocked = await page.waitForSelector('.post-purchase', { timeout: 100 });
		if (eleLocked) {
			console.log('Post is locked.');
			locked = 1;
		}
	} catch (error) {
		try {
			// video

			const playVideo = await page.waitForSelector('.video-js button', { timeout: 100 });

			console.log('Found video.');

			await playVideo.click();

			const videoSource = await page.$eval('video > source[label="720"]');
			sources.push(videoSource.getAttribute('src'));
		} catch (error) {
			// images

			sources = await page.evaluate(() => {
				let sources = [];

				const eleSlide = document.querySelector('.swiper-wrapper');
				if (eleSlide) {
					console.log('Found multiple images.');
					sources = Array.from(eleSlide.querySelectorAll('img[draggable="false"]')).map(image => image.getAttribute('src'));
				} else {
					const eleImage = document.querySelector('.img-responsive');
					if (eleImage) {
						console.log('Found single image.');
						sources.push(eleImage.getAttribute('src'));
					}
				}

				return sources;
			});
		}
	}

	console.log(sources);

	let description = '';

	try {
		description = await page.$eval('.b-post__text-el', (element) => element.innerText);
	} catch (errors) {
	}

	const timestamp = await page.$eval('.b-post__date > span', (element) => element.innerText);

	const post = {
		id: 0,
		sources: sources,
		description: description,
		date: timestamp,
		locked: locked,
		mediaCount: 0,
	};

	db.serialize(() => {
		db.get('SELECT id, cache_media_count FROM Post WHERE url = ?', [url], (_err, row) => {
			console.log(row);
			if (row) {
				post.id = row.id;
				post.mediaCount = row.cache_media_count;
			}
		});

		if (post.id === 0) {
			db.run(`INSERT INTO Post (
				author_id,
				url,
				description,
				timestamp,
				locked,
				cache_media_count
			) VALUES (?, ?, ?, ?, ?, ?)`, [
				author.id,
				url,
				encodeURIComponent(description),
				timestamp,
				locked,
				post.mediaCount
			]);
		}
	});

	let queue = [];

	for (const url of post.sources) {
		db.serialize(() => {
			db.run(`SELECT *
			FROM Media
			WHERE post_id = ?
			AND url = ?`, [
				post.id,
				url
			], (_err, row) => {
				if (!row) {
					queue.push(url);
				}
			});
		});
	}

	let index = 0;
	for (const url of queue) {
		const filePath = await downloadMedia(url, index, author, post);
		console.log(filePath);

		post.mediaCount += 1;

		db.serialize(() => {
			db.run(`UPDATE Post
			SET cache_media_count = ?
			WHERE id = ?`, [
				post.mediaCount,
				post.id
			]);

			db.run(`INSERT INTO Media (
				post_id,
				url,
				file_path
			) VALUES (?, ?, ?)`, [
				post.id,
				url,
				filePath
			]);
		});

		index += 1;
	}
}

async function scrapeMediaPage(page, db, author) {
	// go to media page

	await page.goto(`https://onlyfans.com/${author.id}/media?order=publish_date_asc`, {
		waitUntil: 'networkidle0',
	});

	let unseenPosts = [];

	const postIds = await page.$$eval('.user_posts .b-post', elements => elements.map(post => post.id.match(/postId_(.+)/i)[1]));

	db.serialize(() => {
		for (const id of postIds) {
			db.get('SELECT * FROM Post WHERE id = ?', [id], (_err, row) => {
				if (!row || (row.locked === 0 && row.cache_media_count === 0)) {
					unseenPosts.push(id);
				}
			});
		}
	});

	for (const id of unseenPosts) {
		await scrapePost(page, db, author, `https://onlyfans.com/${id}/${author.id}`);
	}
}

async function scrape() {
	const browser = await puppeteer.launch({
		headless: false,
	});
	const page = await browser.newPage();
	await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0');

	console.log('Loading main page...');

	await page.goto('https://onlyfans.com', {
		waitUntil: 'domcontentloaded',
	});
	await page.waitForSelector('form.b-loginreg__form');

	// log in using twitter

	console.log('Logging in...');

	await page.type('input[name="email"]', auth.username, { delay: 10 });
	await page.type('input[name="password"]', auth.password, { delay: 10 });
	await page.click('button[type="submit"]');

	console.log('Waiting for reCAPTCHA...');

	try {
		await page.waitForSelector('.user_posts', { timeout: 4 * 60 * 1000 });
	} catch {
		process.exit(0);
	}

	await page.waitForSelector('.user_posts', { timeout: 10000 });

	console.log('Logged in.');

	// scrape media pages

	db.all('SELECT * FROM Author', [], (_err, rows) => {
		rows.forEach((row) => {
			const author = Object.assign({}, row);
			scrapeMediaPage(page, db, author);
		});
	});

	db.close();
}
scrape();