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
	timestamp TEXT
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

async function scrapePost(page, author, url) {
	console.log(`Scraping ${url}...`);

	await page.goto(url, {
		waitUntil: 'domcontentloaded',
	});

	await page.waitForSelector('.b-post__wrapper');

	let sources = [];

	let locked = false;

	try {
		// check if locked

		const eleLocked = await page.waitForSelector('.post-purchase', { timeout: 100 });
		if (eleLocked) {
			console.log('Post is locked.');
			locked = true;
		}
	} catch (error) {
		try {
			// video

			const playVideo = await page.waitForSelector('.video-js button', { timeout: 100 });
			await playVideo.click();

			console.log('Found video.');

			const mp4 = await page.waitForSelector('.video-wrapper video > source[label="720"]', { timeout: 100 });
			sources.push(mp4.getAttribute('src'));
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

	const description = await page.$eval('.b-post__text-el', (element) => element.innerText);
	const date = await page.$eval('.b-post__date > span', (element) => element.innerText);

	const post = {
		sources: sources,
		description: description,
		date: date,
		locked: locked
	};

	let index = 0;
	for (const url of post.sources) {
		await downloadMedia(url, index, author, post);
		index += 1;
	}
}

async function scrapeMediaPage(page, author) {
	// go to media page

	await page.goto(`https://onlyfans.com/${author.id}/media?order=publish_date_asc`, {
		waitUntil: 'networkidle0',
	});
	const postIds = await page.$$eval('.user_posts .b-post', elements => elements.map(post => post.id.match(/postId_(.+)/i)[1]));
	for (const id of postIds) {
		await scrapePost(page, author, `https://onlyfans.com/${id}/${author.id}`);
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
			scrapeMediaPage(page, author);
		});
	});

	db.close();
}
scrape();