const puppeteer = require('puppeteer');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

// authentication

const auth = require('./auth.json');

// database

let db = new sqlite3.Database('./storage.db');

fs.exists('./storage.db', (exists) => {
	if (!exists) {
		db.serialize(() => {
			db.run(`CREATE TABLE Author (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL,
				url TEXT
			)`);
		
			db.run(`CREATE TABLE Post (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				author_id TEXT NOT NULL,
				url TEXT NOT NULL,
				description TEXT,
				timestamp TEXT
			)`);
		});
		db.close();
	}
});

// scraping

(async () => {
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

	// go to media page

	await page.goto('https://onlyfans.com/daintywilder/media?order=publish_date_asc', {
		waitUntil: 'networkidle0',
	});
	const postIds = await page.$$eval('.user_posts .b-post', elements => elements.map(post => post.id));
	console.log(postIds);
})();