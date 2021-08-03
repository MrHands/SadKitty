const fs = require('fs');
const https = require('https');
const puppeteer = require('puppeteer');
const { Database } = require('sqlite3');
const util = require('util');

// authentication

const auth = require('./auth.json');

// database

fs.exists('./storage.db', (exists) => {
	if (!exists) {
		let db = new Database('./storage.db', (_err) => {
			db.close();
		});
	}
});

let db = new Database('./storage.db');

const dbGetPromise = (sql, ...params) => {
	return new Promise((resolve, reject) => {
		db.get(sql, ...params, (err, row) => {
			if (err) {
				return reject(err);
			}

			resolve(row);
		})
	});
};

const dbRunPromise = (sql, params) => {
	return new Promise((resolve, reject) => {
		db.run(sql, params, (result, err) => {
			if (err) {
				return reject(err);
			}

			resolve(result);
		})
	});
};

const dbAllPromise = (sql, params) => {
	return new Promise((resolve, reject) => {
		db.all(sql, params, (err, rows) => {
			if (err) {
				return reject(err);
			}

			resolve(rows);
		})
	});
};

const dbSerializePromise = () => {
	return new Promise((resolve, _reject) => {
		db.serialize(() => {
			resolve();
		});
	})
};

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

function getCleanUrl(source) {
	const url = new URL(source);
	return `${url.protocol}//${url.hostname}${url.pathname}`;
}

const dbErrorHandler = (err) => {
	if (err) {
		console.error(err.message);
	}

	return !!err;
}

const dbRunHandler = (_result, err) => {
	return dbErrorHandler(err);
}

// load authors

const authorData = require('./authors.json');

db.serialize(() => {
	authorData.forEach(author => {
		db.run(`INSERT OR IGNORE INTO Author (
			id,
			name,
			url
		) VALUES (?, ?, ?)`, [
			author.id,
			author.name,
			`https://onlyfans.com/${author.id}`
		], dbRunHandler);
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

		let fileName = post.description.replace(/[\\\/\:\*\?\"\<\>\|\. ]/g, '_');
		fileName = encodeURIComponent(fileName);

		if (fileName.length > 80) {
			fileName = fileName.substr(0, 80);
		}

		const postMatch = post.url.match(/.*\/(\d+).*/);
		fileName += ` [${postMatch[1]}]`;

		if (index > 0) {
			fileName += ` (${index + 1})`;
		}

		let dstPath = authorPath + '/' + fileName + '.' + extension;

		console.log(dstPath);

		// download file

		console.log(`Downloading "${dstPath.split('/').pop()}"...`);
	
		let file;
		try {
			file = fs.createWriteStream(dstPath);
		} catch (error) {
			return reject(error);
		}
	
		https.get(url, (response) => {
			response.pipe(file);
			resolve(dstPath);
		}).on('error', (err) => {
			fs.unlink(dstPath);
			console.log(`Failed to download: ${err.message}`);
			return reject(err);
		});
	});
}

async function scrapePost(page, db, author, url) {
	console.log(`Scraping "${url}"...`);

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
			await page.waitForSelector('video > source[label="720"]', { timeout: 2000 });

			console.log('Grabbing source.');

			const videoSource = await page.$eval('video > source[label="720"]', (element) => element.getAttribute('src'));
			sources.push(videoSource);
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

	let description = '';

	try {
		description = await page.$eval('.b-post__text-el', (element) => element.innerText);
	} catch (errors) {
		description = 'none';
	}

	const timestamp = await page.$eval('.b-post__date > span', (element) => element.innerText);

	let post = {
		id: 0,
		url: url,
		sources: sources,
		description: description,
		date: timestamp,
		locked: locked,
		mediaCount: 0,
	};

	// console.log(post.sources);

	await dbGetPromise('SELECT id, cache_media_count FROM Post WHERE url = ?', [url]).then((row) => {
		if (row) {
			post.id = Number(row.id);
			post.mediaCount = row.cache_media_count;
		}
	});

	if (post.id === 0) {
		await dbRunPromise(`INSERT INTO Post (
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

		await dbGetPromise('SELECT id FROM Post WHERE url = ?', [url]).then((row) => {
			post.id = Number(row.id);
		});
	}

	let queue = [];

	for (const source of post.sources) {
		await dbGetPromise(`SELECT *
		FROM Media
		WHERE post_id = ?
		AND url = ?`, [
			post.id,
			getCleanUrl(source)
		]).then((row) => {
			if (!row) {
				queue.push(source);
			}
		});
	}

	let index = 0;
	for (const source of queue) {
		const filePath = await downloadMedia(source, index, author, post);
		// console.log(filePath);

		post.mediaCount += 1;

		await dbRunPromise(`UPDATE Post
		SET cache_media_count = ?
		WHERE id = ?`, [
			post.mediaCount,
			post.id
		]);

		await dbRunPromise(`INSERT INTO Media (
			post_id,
			url,
			file_path
		) VALUES (?, ?, ?)`, [
			post.id,
			getCleanUrl(source),
			filePath
		]);

		index += 1;
	}
}

async function scrapeMediaPage(page, db, author) {
	console.log(`Grabbing posts for ${author.name}...`);

	// go to media page

	await page.goto(`https://onlyfans.com/${author.id}/media?order=publish_date_desc`, {
		waitUntil: 'networkidle0',
	});

	// get all seen posts

	let seenPosts = [];
	let unseenPosts = [];

	await dbAllPromise('SELECT * FROM Post WHERE author_id = ?', author.id).then((rows) => {
		seenPosts = rows.map(row => row.url);
	});
	console.log(seenPosts);

	// wait for page to load

	await page.waitForSelector('.user_posts');

	// scroll down automatically every 3s

	const logger = console.log;

	await page.evaluate(async (logger, seenPosts, unseenPosts) => {
		await new Promise((resolve, _reject) => {
			let totalHeight = 0;
			let distance = 768 * 2;
			let timer = setInterval(() => {
				let scrollHeight = document.body.scrollHeight;
				window.scrollBy(0, distance);
				totalHeight += distance;

				let found = Array.from(document.querySelectorAll('.user_posts .b-post')).map(post => Number(post.id.match(/postId_(.+)/i)[1]));
				logger(found);

				let foundUnseen = [];
				found.forEach(id => {
					if (!seenPosts.includes(id)) {
						foundUnseen.push(id);
					}
				});
				logger(foundUnseen);

				logger(`Found ${foundUnseen.length} new posts...`);

				if (foundUnseen.length === 0 || totalHeight >= scrollHeight) {
					clearInterval(timer);
					resolve();
				}

				unseenPosts += foundUnseen;
			}, 3000);
		});
	}, logger, seenPosts, unseenPosts);

	// get posts

	// const postIds = await page.$$eval('.user_posts .b-post', elements => elements.map(post => Number(post.id.match(/postId_(.+)/i)[1])));

	if (unseenPosts.length === 0) {
		console.log('All posts seen.')
		return;
	}

	// oldest to newest

	unseenPosts.reverse();

	console.log(`Found ${unseenPosts.length} unseen post(s).`);

	for (const id of unseenPosts) {
		await scrapePost(page, db, author, `https://onlyfans.com/${id}/${author.id}`);
	}
}

async function scrape(authors) {
	const browser = await puppeteer.launch({
		headless: false,
	});
	const page = await browser.newPage();
	await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0');
	await page.setViewport({
		width: 1024,
		height: 768
	});

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

	for (const i in authors) {
		const author = authors[i];
		// console.log(author);
		await scrapeMediaPage(page, db, author);
	}

	console.log('Done.');

	db.close();

	process.exit(0);
}

db.serialize(() => {
	db.all('SELECT * FROM Author', [], (err, rows) => {
		if (dbErrorHandler(err)) {
			return;
		}

		let authors = [];

		rows.forEach((row) => {
			const author = Object.assign({}, row);
			authors.push(author);
		});

		scrape(authors);
	});
});