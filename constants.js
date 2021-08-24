export const LOG_TYPES = {
    warning: 'warning',
    log: 'log',
    info: 'info',
    error: 'error',
};

export const CMD_LINE_OPTIONS = [
    {
        name: 'verbose',
        alias: 'v',
        type: Boolean,
    },
    {
        name: 'deleteAuthor',
        type: String,
    },
    {
        name: 'setup',
        type: Boolean,
    },
];
