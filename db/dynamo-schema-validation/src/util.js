// Generates a random date
const randomDate = (start, end) => new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));

// Generates a random decimal number with given precision
const getRandomDecimal = (precision) => parseFloat(Math.random().toFixed(precision));

// Generates a random integer up to a given maximum
const getRandomInt = (max) => Math.floor(Math.random() * max);

module.exports = { randomDate, getRandomDecimal, getRandomInt };
