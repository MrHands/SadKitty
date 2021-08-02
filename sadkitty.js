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
	await page.waitForSelector('form.b-loginreg__form');

	console.log('Logging in...');

	await page.click('a.m-twitter');

	await page.waitForSelector('#oauth_token');
	await page.type('#username_or_email', auth.username);
	await page.type('#password', auth.password);
	await page.click('#allow');
})();