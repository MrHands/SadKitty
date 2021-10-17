import fs from 'fs/promises';
import puppeteer from 'puppeteer-extra';
import sqlite3 from 'sqlite3';
import Downloader from 'nodejs-file-downloader';
import commandLineArgs from 'command-line-args';
import rimraf from 'rimraf';
import prompts from 'prompts';
import chalk from 'chalk';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

import { CMD_LINE_OPTIONS } from './constants.js';
import { logger } from './logger.js';

// command-line

const Options = commandLineArgs(CMD_LINE_OPTIONS);

// files

const fsUnlinkPromise = async (path) => {
    return fs
        .unlink(path)
        .then((path) => path)
        .catch((error) => error);
};

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

// database

fs.stat('./storage.db', (err) => {
    if (err) {
        let db = new sqlite3.Database('./storage.db', (_err) => {
            db.close();
        });
    }
});

let db = new sqlite3.Database('./storage.db');

const dbGetPromise = (sql, ...params) => {
    return new Promise((resolve, reject) => {
        db.get(sql, ...params, (err, row) => {
            if (err) {
                return reject(err);
            }

            resolve(row);
        });
    });
};

const dbRunPromise = (sql, params) => {
    return new Promise((resolve, reject) => {
        db.run(sql, params, (result, err) => {
            if (err) {
                return reject(err);
            }

            resolve(result);
        });
    });
};

const dbAllPromise = (sql, params) => {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) {
                return reject(err);
            }

            resolve(rows);
        });
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

    try {
        await fs.mkdir(authorPath, { recursive: true });
    } catch (err) {
        logger.error(err);
    }

    // get path
    const encoded = new URL(url);
    const extension = encoded.pathname.split('.').pop();

    /** @type {String} */
    let fileName = post.description.replace(/[\\\/\:\*\?\"\<\>\|\. ]/g, '_');
    fileName = encodeURIComponent(fileName);
    fileName = fileName.replace(/_/g, ' ');

    if (fileName.length > 80) {
        fileName = fileName.substr(0, 80);
    }

    fileName = `[${author.id}] ` + fileName;

    const postMatch = post.url.match(/.*\/(\d+).*/);
    fileName += ` [${postMatch[1]}]`;

    if (index > 0) {
        fileName += ` (${index + 1})`;
    }

    fileName += '.' + extension;

    const dstPath = authorPath + '/' + fileName;

    // download file

    logger.info(`Downloading "${dstPath.split('/').pop()}"...`);

    let timeStart = Date.now();

    const downloader = new Downloader({
        url: url,
        directory: authorPath,
        fileName: fileName,
        maxAttempts: 3,
        cloneFiles: true, // don't overwrite existing files
        shouldStop: (error) => {
            logger.error(error);
            return false;
        },
        onProgress: (percentage, _chunk, _remainingSize) => {
            if (Date.now() - timeStart < 10 * 1000) {
                return;
            }

            timeStart = Date.now();

            const barBefore = Math.floor(percentage / 10);
            const barAfter = 10 - barBefore;

            logger.info(`[ ${'#'.repeat(barBefore)}${'.'.repeat(barAfter)} ] ${percentage}%`);
        },
    });

    try {
        await downloader.download();
        await fs.copyFile(dstPath, './downloads/new/' + fileName);
        logger.info(`Succeeded.`);
        return dstPath;
    } catch (error) {
        logger.error(`Failed to download: ${error.message}`);
        return '';
    }
}

async function scrapePost(page, url, author, postIndex, postTotal) {
    logger.info(`(${postIndex + 1} / ${postTotal}) Scraping sources from "${url}"...`);

    // load page and wait for post to appear

    let attempt = 1;
    for (attempt = 1; attempt < 4; ++attempt) {
        if (attempt > 1) {
            logger.warn(`Attempt ${attempt + 1} to scrape page...`);
        }

        try {
            await page.goto(url, {
                waitUntil: 'domcontentloaded',
                timeout: 10 * 1000,
            });

            await page.waitForSelector('.b-post__wrapper', {
                timeout: 10 * 1000,
            });

            break;
        } catch (errors) {
            logger.error('Failed to load page: ' + errors.message);

            await page.reload();
        }
    }

    if (attempt >= 3) {
        logger.error(`Failed to load "${url}", continuing.`);

        return 0;
    }

    // set up post

    let post = {
        id: 0,
        description: '',
        date: '',
        url: url,
        sources: sources,
        mediaCount: 0,
        locked: 0,
    };

    // get sources

    let sources = [];

    for (attempt = 1; attempt < 4; ++attempt) {
        if (attempt > 1) {
            logger.warn(`Attempt ${attempt} to scrape sources...`);
        }

        // check if post is locked

        const eleLocked = await getPageElement(page, '.b-profile__restricted__icon', 1000);
        if (eleLocked) {
            logger.info('Post locked, continuing.');
            post.locked = 1;

            break;
        }

        // get video

        const eleVideo = await getPageElement(page, '.video-js button', 1000);
        if (eleVideo) {
            logger.info('Found video.');

            try {
                eleVideo.click();
            } catch {
                logger.error('Failed to click play button.');
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

            logger.info(`Grabbing source at "${quality}" quality.`);

            try {
                const videoSource = await page.$eval(`video > source[label="${quality}"]`, (element) =>
                    element.getAttribute('src')
                );
                if (!sources.includes(videoSource)) {
                    sources.push(videoSource);
                }
            } catch (error) {
                logger.error('Failed to grab source: ' + error.message);
                continue;
            }
        }

        // get image(s)

        const eleSwiper = await getPageElement(page, '.swiper-wrapper', 1000);
        if (eleSwiper) {
            logger.info('Found multiple images.');

            try {
                const found = await page.$$eval('img[draggable="false"]', (elements) =>
                    elements.map((image) => image.getAttribute('src'))
                );
                found.forEach((imageSource) => {
                    if (!sources.includes(imageSource)) {
                        sources.push(imageSource);
                    }
                });
            } catch (error) {
                logger.error('Failed to grab source: ' + error.message);
                continue;
            }
        }

        const eleImage = await getPageElement(page, '.img-responsive', 1000);
        if (eleImage) {
            logger.info('Found single image.');

            try {
                const imageSource = await page.$eval('.img-responsive', (element) => element.getAttribute('src'));
                if (!sources.includes(imageSource)) {
                    sources.push(imageSource);
                }
            } catch (error) {
                logger.error('Failed to grab source: ' + error.message);
                continue;
            }
        }

        if (sources.length > 0) {
            break;
        }
    }

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

    // create new post

    if (post.id === 0) {
        await dbRunPromise(
            `INSERT INTO Post (
            author_id,
            url,
            description,
            timestamp,
            locked,
            cache_media_count
        ) VALUES (?, ?, ?, ?, ?, ?)`,
            [author.id, post.url, encodeURIComponent(post.description), post.date, post.locked, post.mediaCount]
        );

        await dbGetPromise('SELECT id FROM Post WHERE url = ?', [url]).then((row) => {
            post.id = Number(row.id);
        });
    }

    if (post.sources.length === 0) {
        logger.warn('Nothing to download.');

        return 1;
    }

    let queue = [];

    for (const source of post.sources) {
        await dbGetPromise(
            `SELECT *
            FROM Media
            WHERE post_id = ?
            AND url = ?`,
            [post.id, getCleanUrl(source)]
        ).then((row) => {
            if (!row) {
                queue.push(source);
            }
        });
    }

    if (queue.length > 0) {
        logger.info(`Queueing ${queue.length} download(s)...`);

        let index = 0;
        for (const source of queue) {
            const filePath = await downloadMedia(source, index, author, post);
            if (filePath === '') {
                continue;
            }

            // update media count

            post.mediaCount += 1;

            await dbRunPromise(
                `UPDATE Post
                SET cache_media_count = ?
                WHERE id = ?`,
                [post.mediaCount, post.id]
            );

            // add media to database

            await dbRunPromise(
                `INSERT INTO Media (
                post_id,
                url,
                file_path
                ) VALUES (?, ?, ?)`,
                [post.id, getCleanUrl(source), filePath]
            );

            index += 1;
        }
    } else {
        post.mediaCount = post.sources.length;

        await dbRunPromise(
            `UPDATE Post
            SET cache_media_count = ?
            WHERE id = ?`,
            [post.mediaCount, post.id]
        );
    }

    return post.mediaCount;
}

async function scrapeMediaPage(page, db, author) {
    logger.info(`Checking posts from ${author.name}...`);

    // wait for page to load

    let attempt = 1;
    for (attempt = 1; attempt < 4; ++attempt) {
        if (attempt > 1) {
            logger.info(`Attempt ${attempt} to load media page...`);
        }

        try {
            await page.goto(`https://onlyfans.com/${author.id}/media?order=publish_date_desc`, {
                waitUntil: 'networkidle0',
                timeout: 10 * 1000,
            });
            await page.waitForSelector('.user_posts', {
                timeout: 10 * 1000,
            });

            break;
        } catch (errors) {
            logger.error('Failed to load page: ' + errors.message);

            await page.reload();
        }
    }

    if (attempt >= 3) {
        logger.error('Failed to scrape media page.');

        return;
    }

    // get all seen posts

    let seenPosts = [];

    await dbAllPromise(
        `SELECT *
        FROM Post
        WHERE author_id = ?
        AND cache_media_count > 0`,
        author.id
    ).then((rows) => {
        seenPosts = rows.map((row) => Number(row.url.match(/.*\/(\d+).*/)[1]));
    });

    // scroll down automatically every 3s

    const unseenPosts = await page.evaluate(async (seenPosts) => {
        let unseenPosts = [];

        await new Promise((resolve, _reject) => {
            let totalHeight = 0;
            let nothingFound = 0;
            const MAX_ATTEMPTS = 5;

            let timer = setInterval(() => {
                let scrollHeight = document.body.scrollHeight;

                let distance = document.body.scrollHeight - window.innerHeight - window.scrollY;
                window.scrollBy(0, distance);
                totalHeight += distance;

                console.log(`scrollHeight ${scrollHeight} totalHeight ${totalHeight} distance ${distance}`);

                let found = Array.from(document.querySelectorAll('.user_posts .b-post')).map((post) =>
                    Number(post.id.match(/postId_(.+)/i)[1])
                );

                let foundUnseen = [];
                found.forEach((id) => {
                    if (!seenPosts.includes(id) && !unseenPosts.includes(id)) {
                        foundUnseen.push(id);
                    }
                });

                console.log(`Found ${foundUnseen.length} new posts...`);

                if (foundUnseen.length === 0) {
                    nothingFound++;
                    console.log(`Counter: ${nothingFound}`);
                } else {
                    nothingFound = 0;
                }

                unseenPosts = unseenPosts.concat(foundUnseen);
                // console.log(unseenPosts);
                console.log(`Total: ${unseenPosts.length}`);

                // check if we've scrolled down the entire page

                if (seenPosts.length === 0) {
                    if (distance === 0) {
                        nothingFound = MAX_ATTEMPTS;
                    } else {
                        nothingFound = 0;
                    }
                }

                // check if no posts have been found after multiple retries

                if (nothingFound === MAX_ATTEMPTS) {
                    clearInterval(timer);
                    resolve(unseenPosts);
                }
            }, 2000);
        });

        return unseenPosts;
    }, seenPosts);

    // get posts

    if (unseenPosts.length === 0) {
        logger.info('All posts seen.');

        return;
    }

    // oldest to newest

    unseenPosts.reverse();

    logger.info(`Found ${unseenPosts.length} post(s).`);

    const scrapingFailed = [];

    for (const [index, id] of unseenPosts.entries()) {
        const url = `https://onlyfans.com/${id}/${author.id}`;
        const scraped = await scrapePost(page, url, author, index, unseenPosts.length);
        if (scraped < 1) {
            scrapingFailed.push(url);
        }
    }

    logger.info(`Scraped ${unseenPosts.length} post(s) from ${author.name}.`);

    if (scrapingFailed.length > 0) {
        logger.error(`Failed to scrape: ${scrapingFailed}`);
    }
}

async function setup() {
    const onCancel = () => process.exit(0);

    logger.warn('Setting up authentication for OnlyFans.\n');

    logger.info('Checking for existing authentication data...\n');

    let existingAuthData = { username: '', password: '' };
    try {
        existingAuthData = JSON.parse((await fs.readFile('auth.json', { encoding: 'utf8' })) || {});
        if (Object.keys(existingAuthData || {}).length > 0) {
            logger.info('Auth data found! Skip prompts for input by pressing Enter.\n');
        }
    } catch (err) {
        // Error logs could be hidden behind a command line flag in the future
        logger.error(`Error parsing file ▶ ${err}`);
    }

    const { username, password } = existingAuthData;
    const existingUsername = username ? chalk.yellow.bgBlack` (${username})` : '';
    const existingPassword = password ? chalk.yellow.bgBlack` (${password.substr(0, 3)}******)` : '';

    /** @type {import('prompts').PromptObject<string>[]} */
    const authQuestions = [
        {
            type: 'text',
            name: 'username',
            message: `Username${existingUsername}: `,
            initial: username,
        },
        {
            type: 'password',
            name: 'password',
            message: `Password${existingPassword}: `,
            initial: password,
        },
    ];

    const auth = await prompts(authQuestions, { onCancel });

    await fs.writeFile('auth.json', JSON.stringify(auth));
    
    logger.info('Saved as "auth.json"\n');

    /** @type {{ name: String, id: String}[]} */
    let existingCreatorData;
    try {
        existingCreatorData = JSON.parse((await fs.readFile('authors.json', { encoding: 'utf8' })) || {});
        if (Object.keys(existingCreatorData || {}).length > 0)
            logger.info('Existing creator data will be shown in brackets. Skip prompts for input by pressing Enter.\n');
    } catch (err) {
        // Error logs could be hidden behind a command line flag in the future
        logger.error(`Error parsing file ▶ ${err}`);
    }

    const existingCreatorCount = existingCreatorData ? Object.keys(existingCreatorData || {}).length : 1;
    const formattedCreatorCount = existingCreatorData ? chalk.yellow.bgBlack` (${existingCreatorCount})` : '';

    logger.info('How many creators would you like to scrape?');
    const numCreatorsQ = await prompts(
        {
            name: 'response',
            type: 'number',
            message: `Number of creators${formattedCreatorCount}: `,
            initial: existingCreatorCount,
        },
        {
            onCancel
        }
    );

    /** @type {import('prompts').PromptObject<string>[]} */
    const creatorQuestions = Array.from({ length: numCreatorsQ.response }, () => {}).flatMap(
        /** @returns {import('prompts').PromptObject<string>[]} */
        (_, index) => {
            const existingCreator = existingCreatorData?.[index] || false;
            const existingName = existingCreator
                ? chalk.yellow.bgBlack` (${existingCreator.name} @${existingCreator.id})`
                : '';
            const existingID = existingCreator ? chalk.yellow.bgBlack`${existingCreator.id}` : '<their_creator_id>';

            return [
                {
                    type: 'text',
                    name: 'name',
                    message: `Name of creator #${index + 1}${existingName}: `,
                    initial: existingCreator.name,
                },
                {
                    type: 'text',
                    name: 'id',
                    message: `OnlyFans ID for creator #${index + 1} (https://onlyfans.com/${existingID}): `,
                    initial: existingCreator.id,
                },
            ];
        }
    );

    const authors = [];
    let tempValues = { name: '', id: '' };

    /** @type {import('prompts').Options["onSubmit"]} */
    const onSubmit = (prompt, answer) => {
        if (prompt.name === 'name') {
            tempValues = {};
            tempValues.name = answer;
        } else if (prompt.name === 'id') {
            tempValues.id = answer;
            authors.push(tempValues);
        }
    };

    await prompts(creatorQuestions, { onCancel, onSubmit });
    await fs.writeFile('authors.json', JSON.stringify(authors));

    logger.info('Saved as "authors.json"\n');

    logger.info('Ready to start scraping!');

    process.exit(0);
}

async function scrape() {
    // authentication

    let auth;
    try {
        auth = JSON.parse((await fs.readFile('auth.json')) || {});
        if (Object.keys(auth).length !== 2) throw new Error();
    } catch (error) {
        logger.error('Missing authentication data!');
        logger.info('Create an "auth.json" file in this folder with the following:');
        logger(
            JSON.stringify({
                username: 'me@mine.com',
                password: 'supersecure',
            })
        );
        process.exit(0);
    }

    // get authors

    let authors = [];
    let authorData = [];
    try {
        authorData = JSON.parse((await fs.readFile('authors.json')) || {});
        if (!Object.keys(authorData)) throw new Error();
    } catch (error) {
        logger.error("Missing creator's data!");
        logger.info('Create an "authors.json" in this folder:');
        logger(
            JSON.stringify([
                {
                    id: 'found_in_the_onlyfans_url',
                    name: 'How you want the Artist to appear',
                },
            ])
        );
        process.exit(0);
    }

    for (const data of authorData) {
        await dbRunPromise(`INSERT OR IGNORE INTO Author (id, name, url) VALUES (?, ?, ?)`, [
            data.id,
            data.name,
            `https://onlyfans.com/${data.id}`,
        ]);

        await dbGetPromise('SELECT * FROM Author WHERE id = ?', data.id).then((author) => {
            authors.push(author);
        });
    }

    // hide puppeteer usage

    puppeteer.use(StealthPlugin());

    // open browser

    let browser = await puppeteer.launch({
        ignoreHTTPSErrors: true,
        headless: false,
        args: [
            '--window-size=1920,1080',
            '--window-position=000,000',
            '--disable-dev-shm-usage',
            '--no-sandbox',
            '--disable-web-security',
            '--disable-features=site-per-process',
        ],
    });
    browser.on('disconnected', async () => {
        logger.error('Connection lost.');

        await browser.close();

        if (browser.process()) {
            browser.process().kill('SIGINT');
        }

        process.exit(0);
    });

    const [ page ] = await browser.pages();

    logger.info('Loading main page...');

    await page.goto('https://onlyfans.com', {
        waitUntil: 'domcontentloaded',
    });
    await page.waitForSelector('form.b-loginreg__form');

    // log in using twitter

    logger.info('Logging in...');

    await page.type('input[name="email"]', auth.username, { delay: 10 });
    await page.type('input[name="password"]', auth.password, { delay: 10 });
    await page.click('button[type="submit"]');

    logger.info('Waiting for reCAPTCHA...');

    let attempt = 1;
    for (attempt = 1; attempt < 6; attempt++) {
        try {
            await page.waitForSelector('.user_posts', { timeout: 60 * 1000 });
            break;
        } catch {
            if (attempt > 1) {
                logger.warn(`Checking for reCAPTCHA again in 1 minute...`);
            }
        }
    }

    if (attempt >= 5) {
        logger.error('Timed out on reCAPTCHA.');

        process.exit(0);
    }

    logger.info('Logged in.');

    // clear downloads

    logger.info('Clearing downloads folder.');

    await rimrafPromise('./downloads/new');

    fs.mkdir('./downloads/new', { recursive: true });

    // scrape media pages

    logger.info(`Visiting ${authors.length} author(s).`);

    for (const i in authors) {
        const author = authors[i];
        try {
            await scrapeMediaPage(page, db, author);
        } catch (err) {
            logger.error(`Unexpected error occured ▶ ${err}`);
        }
    }

    logger.info('Done.');

    db.close();

    process.exit(0);
}

if (Options.setup) {
    setup();
} else if (Options.deleteAuthor) {
    (async function () {
        logger.info(`Deleting "${Options.deleteAuthor}"...`);

        let allPosts = [];

        await dbAllPromise('SELECT * FROM Post WHERE author_id = ?', Options.deleteAuthor).then((authorPosts) => {
            if (authorPosts) {
                allPosts = authorPosts.map((post) => post.id);
            }
        });

        let allMedia = [];

        for (const id of allPosts) {
            await dbGetPromise('SELECT * FROM Media WHERE post_id = ?', id).then((media) => {
                if (media) {
                    allMedia.push(media);
                }
            });
        }

        logger.info(`Deleting ${allMedia.length} file(s)...`);

        for (const media of allMedia) {
            await fsUnlinkPromise(media.file_path);
            await dbRunPromise('DELETE FROM Media WHERE id = ?', media.id);
        }

        logger.info(`Deleting ${allPosts.length} post(s)...`);

        for (const id of allPosts) {
            await dbRunPromise('DELETE FROM Post WHERE id = ?', id);
        }

        await dbRunPromise('DELETE FROM Author WHERE id = ?', Options.deleteAuthor);

        logger.info(`Deleted "${Options.deleteAuthor}".`);

        db.close();

        process.exit(0);
    })();
} else {
    scrape();
}
