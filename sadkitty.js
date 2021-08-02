const puppeteer = require('puppeteer');

const auth = require('./auth.json');

(async () => {
	const browser = await puppeteer.launch({
		headless: false,
	});
	const page = await browser.newPage();
	page.on('console', (message) => {
		console.log(message.text());
	});

	console.log('Loading main page...');

	await page.goto('https://onlyfans.com', {
		waitUntil: 'domcontentloaded',
	});
	let twitterLink = await page.waitForSelector('a.m-twitter');

	console.log('Logging in...');

	twitterLink.click();

	await page.waitForSelector('#oauth_form');
	page.type('#username_or_email', auth.username);
	page.type('#password', auth.password);
	page.click('#allow');
})();