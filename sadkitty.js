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

async function downloadMedia(url, author, post) {
	return new Promise((resolve, reject) => {
		// get filename from description

		let fileName = post.description.replace(/[ ]/g, '_');
		fileName = encodeURIComponent(fileName);
	
		// create directories

		const authorPath = `./downloads/${author.id}`;

		if (!fs.existsSync(authorPath)) {
			fs.mkdirSync(authorPath, { recursive: true });
		}

		// make sure filename is unique

		const encoded = new URL(url);
		const extension = encoded.pathname.split('.').pop();

		let dstPath = authorPath + '/' + fileName + '.' + extension;

		let attempt = 0;
		let exists = false;
		do {
			fs.exists(dstPath, (result) => {
				exists = result;
				if (exists) {
					dstPath = authorPath + `/${fileName} (${attempt}).${extension}`;
					attempt += 1;
				}
			});
		} while(exists);

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
	await page.goto(url, {
		waitUntil: 'domcontentloaded',
	});

	await page.waitForSelector('.b-post__wrapper');

	const sources = await page.evaluate(() => {
		let sources = [];

		const eleSlide = document.querySelector('.swiper-wrapper');
		if (eleSlide) {
			sources = Array.from(eleSlide.querySelectorAll('img[draggable="false"]')).map(image => image.getAttribute('src'));
		} else {
			const eleImage = document.querySelector('.img-responsive');
			if (eleImage) {
				sources.push(eleImage.getAttribute('src'));
			}
		}
		return sources;
	});

	const description = await page.$eval('.b-post__text-el', (element) => element.innerText);
	const date = await page.$eval('.b-post__date > span', (element) => element.innerText);

	const post = {
		sources: sources,
		description: description,
		date: date,
	};
	await post.sources.map((url) => downloadMedia(url, author, post));
}

async function scrapeMediaPage(page, author) {
	// go to media page

	await page.goto(`https://onlyfans.com/${author.id}/media?order=publish_date_asc`, {
		waitUntil: 'networkidle0',
	});
	const postIds = await page.$$eval('.user_posts .b-post', elements => elements.map(post => post.id.match(/postId_(.+)/gi))[1]);
	console.log(postIds);
	await postIds.map((id) => scrapePost(page, author, `https://onlyfans.com/${id}/${author.id}`));
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