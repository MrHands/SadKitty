const puppeteer = require('puppeteer');

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

	// await page.click('a.m-twitter');
})();