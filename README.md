SadKitty is a back-up tool for content you've bought on [OnlyFans.com](https://onlyfans.com). Handy when said content is scheduled to disappear on _October 1st, 2021_.

**IMPORTANT**: SadKitty cannot access content from creators you haven't subscribed to!

# Getting started

SadKitty requires [NPM](https://nodejs.org) to be installed.

Open a command-line window in the project directory and install dependencies:

    npm install

Next, run this command to get started:

    npm run setup

Now you can run the following command to scrape posts from your favorite creators:

    npm run scrape

Happy scraping!

# How it works

SadKitty uses [Puppeteer](https://github.com/puppeteer) to open a browser window to the website. After logging in, the script visits all posts from a creator from oldest to newest. It uses [nodejs-file-downloader](https://www.npmjs.com/package/nodejs-file-downloader) to download images and video.

SadKitty stores information about the posts it has seen in a local SQLite database. This is used both to ensure that you don't download content more than once and to check which content you haven't seen yet.