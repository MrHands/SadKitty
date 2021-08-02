const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

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

async function scrapePost(page, url) {
	await page.goto(url, {
		waitUntil: 'domcontentloaded',
	});

	await page.waitForSelector('.b-post__wrapper');

	const description = await page.$eval('.b-post__text-el', (element) => element.innerText);
	const date = await page.$eval('.b-post__date > span', (element) => element.innerText);

	const imageSources = await page.evaluate(() => {
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

	console.log(description);
	console.log(date);
	console.log(imageSources);
}

async function scrapeMediaPage(page, author) {
	// go to media page

	await page.goto(`https://onlyfans.com/${author.id}/media?order=publish_date_asc`, {
		waitUntil: 'networkidle0',
	});
	const postIds = await page.$$eval('.user_posts .b-post', elements => elements.map(post => post.id.match(/postId_(.+)/g))[1]);
	console.log(postIds);
}

async function scrape() {
	const browser = await puppeteer.launch({
		headless: false,
	});
	const page = await browser.newPage();
	
	console.log('Loading main page...');

	await page.goto('https://onlyfans.com', {
		waitUntil: 'domcontentloaded',
	});
	await page.waitForSelector('form.b-loginreg__form');

	// log in using twitter

	console.log('Logging in...');

	await page.click('a.m-twitter');

	await page.waitForSelector('#oauth_token');
	await page.type('#username_or_email', auth.username);
	await page.type('#password', auth.password);
	await page.click('#allow');

	// wait for posts to appear

	await page.waitForSelector('.user_posts');

	console.log('Logged in.');

	// scrape media pages

	/*db.all('SELECT * FROM Author', [], (_err, rows) => {
		rows.forEach((row) => {
			const author = Object.assign({}, row);
			await scrapeMediaPage(page, author);
		});
	});*/
	await scrapePost(page, 'https://onlyfans.com/21001691/daintywilder');
	await scrapePost(page, 'https://onlyfans.com/176755052/daintywilder');
}
scrape();

db.close();