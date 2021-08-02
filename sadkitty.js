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

const authors = require('./authors.json');

let db = new sqlite3.Database('./storage.db');
db.serialize(() => {
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

	authors.forEach(author => {
		db.run(`INSERT OR IGNORE INTO Author (id, name, url) VALUES (?, ?, ?)`, [author.id, author.name, `https://onlyfans.com/${author.id}`]);
	});

	db.all('SELECT * FROM Author', [], (_err, rows) => {
		rows.forEach((row) => {
			console.log(`name: ${row.name}`);
		});
	});
});

db.close();

// scraping

/*(async () => {
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
})();*/