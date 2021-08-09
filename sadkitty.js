const fs = require('fs');
const puppeteer = require('puppeteer');
const { Database } = require('sqlite3');
const Downloader = require('nodejs-file-downloader');
const rimraf = require('rimraf');
const commandLineArgs = require('command-line-args');

// logging

function logger(message) {
	const now = new Date(Date.now());
	console.log(`[${('0' + now.getHours()).slice(-2)}:${('0' + now.getMinutes()).slice(-2)}:${('0' + now.getSeconds()).slice(-2)}]`, message);
}

// command-line

const cmdLineOptions = [
	{
		name: 'verbose',
		alias: 'v',
		type: Boolean
	},
	{
		name: 'deleteAuthor',
		type: String
	},
];
const Options = commandLineArgs(cmdLineOptions);

// files

const fsUnlinkPromise = (path) => {
	return new Promise((resolve, reject) => {
		fs.unlink(path, (error) => {
			if (error) {
				return reject(error);
			}

			resolve(path);
		});
	});
}

const rimrafPromise = (path, options = {}) => {
	return new Promise((resolve, reject) => {
		rimraf(path, options, (error) => {
			if (error) {
				return reject(error);
			}

			resolve(path);
		});
	});
};

// authentication

let auth;
try {
	auth = require('./auth.json');
} catch (error) {
	logger('Missing auth.json file!');
	logger('Create the file in this folder with the following:');
	logger({
		username: 'me@mine.com',
		password: 'supersecure'
	});
	process.exit(0);
}

// authors

let authorData = [];
try {
	authorData = require('./authors.json');
} catch (error) {
	logger('Missing authors.json file!');
	logger('Create an authors.json in this folder:');
	logger([
		{
			id: 'found_in_the_onlyfans_url',
			name: 'How you want the Artist to appear'
		}
	]);
	process.exit(0);
}

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

function getCleanUrl(source) {
	const url = new URL(source);
	return `${url.protocol}//${url.hostname}${url.pathname}`;
}

// schema

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

// scraping

async function getPageElement(page, selector, timeout = 100) {
	try {
		const element = await page.waitForSelector(selector, { timeout: timeout });
		return element;
	} catch {
		return null;
	}
}

async function downloadMedia(url, index, author, post) {
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

	fileName += '.' + extension;

	let dstPath = authorPath + '/' + fileName;

	// download file

	logger(`Downloading "${dstPath.split('/').pop()}"...`);

	let timeStart = Date.now();

	const downloader = new Downloader({
		url: url,
		directory: authorPath,
		fileName: fileName,
		maxAttempts: 3,
		cloneFiles: true, // don't overwrite existing files
		shouldStop: (error) => {
			logger(error);
			return false;
		},
		onProgress: (percentage, _chunk, _remainingSize) => {
			if (Date.now() - timeStart < 10 * 1000) {
				return;
			}

			timeStart = Date.now();

			const barBefore = Math.floor(percentage / 10);
			const barAfter = 10 - barBefore;

			logger(`[ ${'#'.repeat(barBefore)}${'.'.repeat(barAfter)} ] ${percentage}%`);
		}
	});

	try {
		await downloader.download();
		await fs.promises.copyFile(dstPath, './downloads/new/' + fileName);
		logger(`Succeeded.`);
		return dstPath;
	} catch (error) {
		logger(`Failed to download: ${error.message}`);
		return '';
	}
}

async function scrapePost(page, url, author, postIndex, postTotal) {
	logger(`(${postIndex + 1} / ${postTotal}) Scraping sources from "${url}"...`);

	// load page and wait for post to appear

	let attempt = 1;
	for (attempt = 1; attempt < 4; ++attempt) {
		if (attempt > 1) {
			logger(`Attempt ${attempt + 1} to scrape page...`);
		}

		try {
			await page.goto(url, {
				waitUntil: 'domcontentloaded',
				timeout: 10 * 1000
			});

			await page.waitForSelector('.b-post__wrapper', {
				timeout: 10 * 1000
			});

			break;
		} catch (errors) {
			logger('Failed to load page: ' + errors.message);

			await page.reload();
		}
	};

	if (attempt >= 3) {
		logger(`Failed to load "${url}", continuing.`);

		return 0;
	}

	let sources = [];

	for (attempt = 1; attempt < 4; ++attempt) {
		if (attempt > 1) {
			logger(`Attempt ${attempt} to scrape sources...`);
		}

		// get video

		const eleVideo = await getPageElement(page, '.video-js button', 1000);
		if (eleVideo) {
			logger('Found video.');

			try {
				eleVideo.click();
			} catch {
				logger('Failed to click play button.');
				continue;
			}

			let quality = '720';
			const qualityLevels = ['720', 'original', '480', '240'];
			for (let q in qualityLevels) {
				try {
					await page.waitForSelector(`video > source[label="${qualityLevels[q]}"]`, { timeout: 2000 });
					quality = qualityLevels[q];
					break;
				} catch {
					continue;
				}
			}

			logger(`Grabbing source at "${quality}" quality.`);

			try {
				const videoSource = await page.$eval(`video > source[label="${quality}"]`, (element) => element.getAttribute('src'));
				if (!sources.includes(videoSource)) {
					sources.push(videoSource);
				}
			} catch (error) {
				logger('Failed to grab source: ' + error.message);
				continue;
			}
		}

		// get image(s)

		const eleSwiper = await getPageElement(page, '.swiper-wrapper', 1000);
		if (eleSwiper) {
			logger('Found multiple images.');

			try {
				const found = await page.$$eval('img[draggable="false"]', elements => elements.map(image => image.getAttribute('src')));
				found.forEach(imageSource => {
					if (!sources.includes(imageSource)) {
						sources.push(imageSource);
					}
				});
			} catch (error) {
				logger('Failed to grab source: ' + error.message);
				continue;
			}
		}

		const eleImage = await getPageElement(page, '.img-responsive', 1000);
		if (eleImage) {
			logger('Found single image.');

			try {
				const imageSource = await page.$eval('.img-responsive', (element) => element.getAttribute('src'));
				if (!sources.includes(imageSource)) {
					sources.push(imageSource);
				}
			} catch (error) {
				logger('Failed to grab source: ' + error.message);
				continue;
			}
		}

		if (sources.length > 0) {
			break;
		}
	}

	// set up post

	let post = {
		id: 0,
		url: url,
		sources: sources,
		mediaCount: 0,
	};

	// get id
	
	await dbGetPromise('SELECT id, cache_media_count FROM Post WHERE url = ?', [url]).then((row) => {
		if (row) {
			post.id = Number(row.id);
			post.mediaCount = row.cache_media_count;
		}
	});

	// get description

	try {
		post.description = await page.$eval('.b-post__text-el', (element) => element.innerText);
	} catch (errors) {
		post.description = 'none';
	}

	// get timestamp

	post.date = await page.$eval('.b-post__date > span', (element) => element.innerText);

	// check if locked

	const eleLocked = await getPageElement(page, '.post-purchase');
	if (eleLocked) {
		logger('Post is locked.');

		// b-post__price
		post.locked = 1;
	}

	// create new post

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
			post.url,
			encodeURIComponent(post.description),
			post.date,
			post.locked,
			post.mediaCount
		]);

		await dbGetPromise('SELECT id FROM Post WHERE url = ?', [url]).then((row) => {
			post.id = Number(row.id);
		});
	}

	if (post.sources.length === 0) {
		logger('Nothing to download.');

		return 1;
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

	if (queue.length > 0) {
		logger(`Queueing ${queue.length} download(s)...`);

		let index = 0;
		for (const source of queue) {
			const filePath = await downloadMedia(source, index, author, post);
			if (filePath === '') {
				continue;
			}

			// update media count
	
			post.mediaCount += 1;
	
			await dbRunPromise(`UPDATE Post
			SET cache_media_count = ?
			WHERE id = ?`, [
				post.mediaCount,
				post.id
			]);

			// add media to database
	
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
	} else {
		post.mediaCount = post.sources.length;

		await dbRunPromise(`UPDATE Post
		SET cache_media_count = ?
		WHERE id = ?`, [
			post.mediaCount,
			post.id
		]);
	}

	return post.mediaCount;
}

async function scrapeMediaPage(page, db, author) {
	logger(`Checking posts from ${author.name}...`);

	// wait for page to load

	let attempt = 1;
	for (attempt = 1; attempt < 4; ++attempt) {
		if (attempt > 1) {
			logger(`Attempt ${attempt} to load media page...`);
		}

		try {
			await page.goto(`https://onlyfans.com/${author.id}/media?order=publish_date_desc`, {
				waitUntil: 'networkidle0',
				timeout: 10 * 1000
			});
			await page.waitForSelector('.user_posts', {
				timeout: 10 * 1000
			});

			break;
		} catch (errors) {
			logger('Failed to load page: ' + errors.message);

			await page.reload();
		}
	}

	if (attempt >= 3) {
		logger('Failed to scrape media page.');

		return;
	}

	// get all seen posts

	let seenPosts = [];

	await dbAllPromise(`SELECT *
		FROM Post
		WHERE author_id = ?
		AND cache_media_count > 0`, author.id)
		.then((rows) => {
			seenPosts = rows.map(row => Number(row.url.match(/.*\/(\d+).*/)[1]));
		});

	// scroll down automatically every 3s

	const unseenPosts = await page.evaluate(async (seenPosts) => {
		let unseenPosts = [];

		await new Promise((resolve, _reject) => {
			let totalHeight = 0;
			let nothingFound = 0;

			let timer = setInterval(() => {
				let scrollHeight = document.body.scrollHeight;

				let distance = document.body.scrollHeight - window.innerHeight - window.scrollY;
				window.scrollBy(0, distance);
				totalHeight += distance;

				console.log(`scrollHeight ${scrollHeight} totalHeight ${totalHeight} distance ${distance}`);

				let found = Array.from(document.querySelectorAll('.user_posts .b-post')).map(post => Number(post.id.match(/postId_(.+)/i)[1]));

				let foundUnseen = [];
				found.forEach(id => {
					if (!seenPosts.includes(id) && !unseenPosts.includes(id)) {
						foundUnseen.push(id);
					}
				});

				console.log(`Found ${foundUnseen.length} new posts...`);

				if (foundUnseen.length === 0) {
					nothingFound += 1;
					console.log(`Counter: ${nothingFound}`);
				} else {
					nothingFound = 0;
				}

				unseenPosts = unseenPosts.concat(foundUnseen);
				// console.log(unseenPosts);
				console.log(`Total: ${unseenPosts.length}`);

				// check if we've scrolled down the entire page

				if (nothingFound === 6 || distance === 0) {
					clearInterval(timer);
					resolve(unseenPosts);
				}
			}, 2000);
		});

		return unseenPosts;
	}, seenPosts);

	// get posts

	if (unseenPosts.length === 0) {
		logger('All posts seen.');

		return;
	}

	// oldest to newest

	unseenPosts.reverse();

	logger(`Found ${unseenPosts.length} post(s).`);

	scrapingFailed = [];

	for (const [index, id] of unseenPosts.entries()) {
		const url = `https://onlyfans.com/${id}/${author.id}`;
		const scraped = await scrapePost(page, url, author, index, unseenPosts.length);
		if (scraped < 1) {
			scrapingFailed.push(url);
		}
	}

	logger(`Scraped ${unseenPosts.length} post(s) from ${author.name}.`);

	if (scrapingFailed.length > 0) {
		logger(`Failed to scrape:`);
		logger(scrapingFailed);
	}
}

async function scrape() {
	// get authors

	let authors = [];

	for (const data of authorData) {
		await dbRunPromise(`INSERT OR IGNORE INTO Author (id, name, url) VALUES (?, ?, ?)`, [
			data.id,
			data.name,
			`https://onlyfans.com/${data.id}`
		]);

		await dbGetPromise('SELECT * FROM Author WHERE id = ?', data.id).then((author) => {
			authors.push(author);
		});
	}

	// open browser

	let browser = await puppeteer.launch({
		headless: false,
	});
	browser.on('disconnected', async () => {
		logger('Connection lost.');

		await browser.close();
		
		if (browser.process()) {
			browser.process().kill('SIGINT');
		}

		process.exit(0);
	});

	const page = await browser.newPage();
	await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:90.0) Gecko/20100101 Firefox/90.0');
	await page.setViewport({
		width: 1024,
		height: 768
	});

	logger('Loading main page...');

	await page.goto('https://onlyfans.com', {
		waitUntil: 'domcontentloaded',
	});
	await page.waitForSelector('form.b-loginreg__form');

	// log in using twitter

	logger('Logging in...');

	await page.type('input[name="email"]', auth.username, { delay: 10 });
	await page.type('input[name="password"]', auth.password, { delay: 10 });
	await page.click('button[type="submit"]');

	logger('Waiting for reCAPTCHA...');

	let attempt = 1;
	for (attempt = 1; attempt < 6; attempt++) {
		try {
			await page.waitForSelector('.user_posts', { timeout: 60 * 1000 });

			break;
		} catch {
			if (attempt > 1) {
				logger(`Checking for reCAPTCHA again in 1 minute...`);
			}
		}
	}

	if (attempt >= 5) {
		logger('Timed out on reCAPTCHA.');
	
		process.exit(0);
	}

	logger('Logged in.');

	// clear downloads

	logger('Clearing downloads folder.');

	await rimrafPromise('./downloads/new');

	fs.mkdirSync('./downloads/new', { recursive: true });

	// scrape media pages

	logger(`Visiting ${authors.length} author(s).`);

	for (const i in authors) {
		const author = authors[i];
		await scrapeMediaPage(page, db, author);
	}

	logger('Done.');

	db.close();

	process.exit(0);
}

if (Options.deleteAuthor) {
	(async function() {
		logger(`Deleting "${Options.deleteAuthor}"...`);

		let allPosts = [];

		await dbAllPromise('SELECT * FROM Post WHERE author_id = ?', Options.deleteAuthor).then((authorPosts) => {
			allPosts = authorPosts.map((post) => post.id);
		});

		let allMedia = [];

		for (const id of allPosts) {
			await dbGetPromise('SELECT * FROM Media WHERE post_id = ?', id).then((media) => {
				allMedia.push(media);
			});
		}

		logger(`Deleting ${allMedia.length} file(s)...`);

		for (const media of allMedia) {
			await fsUnlinkPromise(media.file_path);
			await dbRunPromise('DELETE FROM Media WHERE id = ?', media.id);
		}

		logger(`Deleting ${allPosts.length} post(s)...`);

		for (const id of allPosts) {
			await dbRunPromise('DELETE FROM Post WHERE id = ?', id);
		}

		await dbRunPromise('DELETE FROM Author WHERE id = ?', Options.deleteAuthor);

		logger(`Deleted "${Options.deleteAuthor}".`);

		db.close();

		process.exit(0);
	})();
} else {
	scrape();
}
