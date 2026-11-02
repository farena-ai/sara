// Phase 127 (2.60.0, docs/design/PACKS.md §10.3, §16 Q11): the real-person tripwire. A pack whose
// name or summary names one of these public figures is held until the author ticks "She isn't a
// real person, or that person said yes". It is a tripwire, not a judgement, and short on purpose
// (≤ 300 names, full names only so ordinary first names never trip it). FOR THE OWNER TO REVIEW:
// add or remove names freely; the check reads this list and nothing else.
export const REAL_PEOPLE: readonly string[] = [
  // music
  'Taylor Swift', 'Ariana Grande', 'Billie Eilish', 'Selena Gomez', 'Beyonce', 'Rihanna', 'Lady Gaga', 'Dua Lipa', 'Sabrina Carpenter', 'Olivia Rodrigo',
  'Miley Cyrus', 'Katy Perry', 'Nicki Minaj', 'Cardi B', 'Doja Cat', 'Megan Thee Stallion', 'Lizzo', 'Shakira', 'Jennifer Lopez', 'Britney Spears',
  'Ed Sheeran', 'Justin Bieber', 'Harry Styles', 'Shawn Mendes', 'The Weeknd', 'Bruno Mars', 'Kanye West', 'Aubrey Graham',
  'Travis Scott', 'Post Malone', 'Bad Bunny', 'Chappell Roan', 'Charli XCX', 'Lana Del Rey', 'Avril Lavigne',
  'Jungkook Jeon', 'Kim Taehyung', 'Park Jimin', 'Lalisa Manobal', 'Jennie Kim', 'Kim Jisoo', 'Roseanne Park', 'Jang Wonyoung', 'Kim Chaewon', 'Hanni Pham',
  'Michael Jackson', 'Elvis Presley', 'Freddie Mercury', 'Snoop Dogg', 'Eminem', 'Marshall Mathers',
  // film and television
  'Emma Watson', 'Scarlett Johansson', 'Margot Robbie', 'Zendaya', 'Jenna Ortega', 'Sydney Sweeney', 'Anya Taylor-Joy', 'Gal Gadot', 'Natalie Portman', 'Jennifer Lawrence',
  'Jennifer Aniston', 'Angelina Jolie', 'Emma Stone', 'Florence Pugh', 'Millie Bobby Brown', 'Ana de Armas', 'Megan Fox', 'Kristen Stewart', 'Anne Hathaway', 'Elizabeth Olsen',
  'Emilia Clarke', 'Sophie Turner', 'Maisie Williams', 'Keira Knightley', 'Marilyn Monroe', 'Audrey Hepburn', 'Salma Hayek', 'Penelope Cruz', 'Monica Bellucci',
  'Brad Pitt', 'Tom Cruise', 'Keanu Reeves', 'Leonardo DiCaprio', 'Johnny Depp', 'Ryan Reynolds', 'Ryan Gosling', 'Chris Hemsworth', 'Chris Evans', 'Chris Pratt',
  'Henry Cavill', 'Timothee Chalamet', 'Tom Holland', 'Pedro Pascal', 'Dwayne Johnson', 'Robert Downey Jr', 'Benedict Cumberbatch', 'Idris Elba', 'Jason Momoa', 'Zac Efron',
  'Hugh Jackman', 'Tom Hiddleston', 'Cillian Murphy', 'Jacob Elordi', 'Austin Butler', 'Paul Mescal', 'Jeremy Allen White', 'Glen Powell', 'Morgan Freeman', 'Will Smith',
  'Jackie Chan', 'Sandra Bullock', 'Julia Roberts', 'Meryl Streep', 'Nicole Kidman', 'Charlize Theron', 'Cate Blanchett', 'Halle Berry', 'Jessica Alba',
  // online
  'MrBeast', 'Jimmy Donaldson', 'PewDiePie', 'Felix Kjellberg', 'Pokimane', 'Imane Anys', 'Amouranth', 'Kaitlyn Siragusa', 'Belle Delphine', 'Logan Paul', 'Jake Paul', 'Olajide Olatunji',
  'Kai Cenat', 'IShowSpeed', 'Darren Watkins', 'Tyler Blevins', 'Valkyrae', 'Rachell Hofstetter', 'Corinna Kopf', 'Addison Rae', 'Charli DAmelio',
  'Khaby Lame', 'Bella Poarch', 'Emma Chamberlain', 'Hasan Piker', 'Ludwig Ahgren', 'Felix Lengyel', 'Markiplier', 'Mark Fischbach',
  'Andrew Tate', 'Joe Rogan', 'Jordan Peterson', 'Ben Shapiro', 'Tucker Carlson', 'Alex Jones', 'Piers Morgan', 'Gordon Ramsay', 'Oprah Winfrey', 'Ellen DeGeneres',
  // reality and fashion
  'Kim Kardashian', 'Kylie Jenner', 'Kendall Jenner', 'Khloe Kardashian', 'Kourtney Kardashian', 'Paris Hilton', 'Gigi Hadid', 'Bella Hadid', 'Hailey Bieber', 'Emily Ratajkowski',
  'Cara Delevingne', 'Heidi Klum', 'Tyra Banks', 'Naomi Campbell', 'Kate Moss',
  // sport
  'Cristiano Ronaldo', 'Lionel Messi', 'Neymar Junior', 'Kylian Mbappe', 'Erling Haaland', 'David Beckham', 'LeBron James', 'Michael Jordan', 'Stephen Curry', 'Serena Williams',
  'Simone Biles', 'Naomi Osaka', 'Travis Kelce', 'Tom Brady', 'Conor McGregor', 'Floyd Mayweather', 'Mike Tyson', 'Lewis Hamilton', 'Max Verstappen', 'Usain Bolt',
  // business and technology
  'Elon Musk', 'Mark Zuckerberg', 'Bill Gates', 'Jeff Bezos', 'Sam Altman', 'Steve Jobs', 'Tim Cook', 'Jensen Huang', 'Warren Buffett', 'Sundar Pichai',
  // politics and royalty
  'Donald Trump', 'Joe Biden', 'Barack Obama', 'Michelle Obama', 'Kamala Harris', 'Hillary Clinton', 'Bill Clinton', 'Vladimir Putin', 'Xi Jinping', 'Kim Jong Un',
  'Volodymyr Zelensky', 'Emmanuel Macron', 'Justin Trudeau', 'Rishi Sunak', 'Keir Starmer', 'Boris Johnson', 'Narendra Modi', 'Benjamin Netanyahu', 'Javier Milei', 'Giorgia Meloni',
  'Alexandria Ocasio-Cortez', 'Bernie Sanders', 'JD Vance', 'Melania Trump', 'Ivanka Trump', 'King Charles', 'Prince William', 'Prince Harry', 'Meghan Markle', 'Kate Middleton',
  'Princess Diana', 'Queen Elizabeth', 'Pope Francis', 'Pope Leo', 'Greta Thunberg', 'Malala Yousafzai', 'Dalai Lama', 'Nelson Mandela', 'Adolf Hitler', 'Kim Yo Jong',
];

const norm = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const NORMED = REAL_PEOPLE.map((n) => [n, ` ${norm(n)} `] as const);

/** The listed public figure a text names (whole words, any case, accents ignored), if any. */
export function realPersonMatch(text: string): string | undefined {
  const t = ` ${norm(text)} `;
  return NORMED.find(([, n]) => t.includes(n))?.[0];
}
