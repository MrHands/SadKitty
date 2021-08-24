import chalk from 'chalk';

/**
 * Adds a bit of color highlighting to
 * @param {"log"|"info"|"warning"|"error"} type
 */
export function colorMapper(type) {
    switch (type) {
        case 'log':
            return chalk.white.bgBlack;
        case 'info':
            return chalk.blue.bgBlack;
        case 'warning':
            return chalk.yellow.bgBlack;
        case 'error':
            return chalk.red.bgBlack;
        default:
            return chalk.white.bgBlack;
    }
}

/**
 * A simple wrapper around `console.log` with timestamps
 * @param {String} message
 * @param {"log"|"info"|"warning"|"error"} [type='log']
 */
export function logger(message, type = 'log') {
    const now = new Date(Date.now());
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    console.log(colorMapper(type)(`[${hours}:${minutes}:${seconds}]`, message));
}
