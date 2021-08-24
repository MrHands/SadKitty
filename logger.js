import chalk from 'chalk';

export const LEVELS = {
    'fatal': {
        priority: 0,
        chalkFunction: chalk.red.bgBlack
    },
    'error': {
        priority: 1,
        chalkFunction: chalk.red.bgBlack
    },
    'warn': {
        priority: 2,
        chalkFunction: chalk.yellow.bgBlack
    },
    'info': {
        priority: 3,
        chalkFunction: chalk.white.bgBlack
    },
    'trace': {
        priority: 4,
        chalkFunction: chalk.white.bgBlack
    }
};

export const logger = {
    lowest: 0,
    highest: 3,

    log: function(chalkFunction, message) {
        const now = new Date(Date.now());
        const hours = now.getHours().toString().padStart(2, '0');
        const minutes = now.getMinutes().toString().padStart(2, '0');
        const seconds = now.getSeconds().toString().padStart(2, '0');
    
        console.log(chalkFunction(`[${hours}:${minutes}:${seconds}]`, message));
    },

    logLevel: function (level, message) {
        const { priority, chalkFunction } = LEVELS[level];
        if (priority >= this.lowest && priority <= this.highest) {
            this.log(chalkFunction, message);
        }
    },

    fatal: function (message) {
        const { chalkFunction } = LEVELS['fatal'];
        this.log(chalkFunction, message);
    },

    error: function (message) {
        this.logLevel('error', message);
    },

    info: function (message) {
        this.logLevel('info', message);
    },

    trace: (message) => {
        this.logLevel('trace', message);
    },
};