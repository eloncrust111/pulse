// Portland Pilots women's basketball, 2026-27 regular season.
// From https://portlandpilots.com/sports/womens-basketball/schedule (posted times; away games may be local time there).
export const SEASON = '2026-27';
export const GAMES = [
  {"date": "2026-11-02", "opp": "Willamette", "logo": "willamette", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": null, "result": "W 107-29"},
  {"date": "2026-11-05", "opp": "BYU", "logo": "byu", "home": false, "where": "Provo, Utah", "venue": "Marriott Center", "time": "18:00"},
  {"date": "2026-11-08", "opp": "Montana State", "logo": "montana-state", "home": false, "where": "Bozeman, Mont.", "venue": "", "time": "13:00"},
  {"date": "2026-11-11", "opp": "Warner Pacific", "logo": "warner-pacific", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "17:00"},
  {"date": "2026-11-14", "opp": "Long Beach State", "logo": "long-beach-state", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "17:00"},
  {"date": "2026-11-18", "opp": "Portland State", "logo": "portland-state", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "18:00"},
  {"date": "2026-11-22", "opp": "Stanford", "logo": "stanford", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "14:00"},
  {"date": "2026-11-25", "opp": "UC Santa Barbara", "logo": "uc-santa-barbara", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "14:00"},
  {"date": "2026-12-02", "opp": "South Carolina State", "logo": "south-carolina-state", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "18:00"},
  {"date": "2026-12-05", "opp": "Washington State", "logo": "washington-state", "home": false, "where": "Pullman, Wash.", "venue": "Beasley Coliseum", "time": "14:00"},
  {"date": "2026-12-13", "opp": "Princeton", "logo": "princeton", "home": false, "where": "Princeton, NJ", "venue": "", "time": "10:00"},
  {"date": "2026-12-16", "opp": "Oregon", "logo": "oregon", "home": false, "where": "Eugene, Ore.", "venue": "Matthew Knight Arena", "time": "15:00"},
  {"date": "2026-12-19", "opp": "Wyoming", "logo": "wyoming", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "14:00"},
  {"date": "2026-12-21", "opp": "New Mexico", "logo": "new-mexico", "home": false, "where": "Albuquerque, NM", "venue": "", "time": "11:00"},
  {"date": "2026-12-31", "opp": "Pacific", "logo": "pacific", "home": false, "where": "Stockton, Calif.", "venue": "Alex G. Spanos Center", "time": "14:00"},
  {"date": "2027-01-02", "opp": "Santa Clara", "logo": "santa-clara", "home": false, "where": "Santa Clara, Calif.", "venue": "Leavey Center", "time": null},
  {"date": "2027-01-07", "opp": "San Diego", "logo": "san-diego", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "18:00"},
  {"date": "2027-01-09", "opp": "Denver", "logo": "denver", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "17:00"},
  {"date": "2027-01-14", "opp": "Loyola Marymount", "logo": "loyola-marymount", "home": false, "where": "Los Angeles, Calif.", "venue": "Gersten Pavilion", "time": "18:00"},
  {"date": "2027-01-16", "opp": "Pepperdine", "logo": "pepperdine", "home": false, "where": "Malibu, Calif.", "venue": "Firestone Fieldhouse", "time": "18:00"},
  {"date": "2027-01-21", "opp": "San Diego", "logo": "san-diego", "home": false, "where": "San Diego, Calif.", "venue": "Jenny Craig Pavilion", "time": "18:00"},
  {"date": "2027-01-23", "opp": "San Francisco", "logo": "san-francisco", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "17:00"},
  {"date": "2027-01-28", "opp": "Saint Mary's", "logo": "saint-marys", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "18:00"},
  {"date": "2027-01-30", "opp": "Denver", "logo": "denver", "home": false, "where": "Denver, Colo.", "venue": "Hamilton Gymnasium", "time": null},
  {"date": "2027-02-04", "opp": "Seattle U", "logo": "seattle-u", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "18:00"},
  {"date": "2027-02-06", "opp": "San Francisco", "logo": "san-francisco", "home": false, "where": "San Francisco, Calif.", "venue": "War Memorial at The Sobrato Center", "time": "14:00"},
  {"date": "2027-02-11", "opp": "Loyola Marymount", "logo": "loyola-marymount", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "18:00"},
  {"date": "2027-02-13", "opp": "Santa Clara", "logo": "santa-clara", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "17:00"},
  {"date": "2027-02-18", "opp": "Saint Mary's", "logo": "saint-marys", "home": false, "where": "Moraga, Calif.", "venue": "University Credit Union Pavilion", "time": null},
  {"date": "2027-02-20", "opp": "Seattle U", "logo": "seattle-u", "home": false, "where": "Seattle, Wash.", "venue": "Redhawk Center", "time": "13:00"},
  {"date": "2027-02-25", "opp": "Pacific", "logo": "pacific", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "18:00"},
  {"date": "2027-02-27", "opp": "Pepperdine", "logo": "pepperdine", "home": true, "where": "Portland, Ore.", "venue": "Chiles Center", "time": "17:00"},
];

export const gameOn = date => GAMES.find(g => g.date === date);
export const nextGame = date => GAMES.find(g => g.date >= date);
export const teamLogo = g => `icons/teams/${g.logo}.png`;
