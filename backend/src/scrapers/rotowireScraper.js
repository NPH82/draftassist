/**
 * RotoWire College Injury History scraper
 */

const axios = require('axios');
const cheerio = require('cheerio');

const ROTOWIRE_URL = 'https://www.rotowire.com/cfootball/news.php?view=injuries';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
};

async function fetchCollegeInjuries() {
  const { data: html } = await axios.get(ROTOWIRE_URL, { headers: HEADERS, timeout: 15000 });
  const $ = cheerio.load(html);
  const injuries = [];

  $('.news-update').each((_, item) => {
    const name = $(item).find('.news-update__player-link, .player-name').text().trim();
    const description = $(item).find('.news-update__player-news, .news-update__news').text().trim();
    const dateText = $(item).find('.news-update__date, time').text().trim();

    if (name && description) {
      injuries.push({ name, description, dateText });
    }
  });

  return injuries;
}

module.exports = { fetchCollegeInjuries };
