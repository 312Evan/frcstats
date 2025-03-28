const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const fs = require('fs').promises;
const app = express();
const port = 3000;

require('dotenv').config();
const TBA_API_KEY = process.env.blueapi;
const TBA_BASE_URL = 'https://www.thebluealliance.com/api/v3';

app.set('view engine', 'ejs');
app.use(express.static(__dirname + '/public'));
app.use(express.urlencoded({ extended: true }));

const fetchTBA = async (endpoint) => {
  try {
    const response = await axios.get(`${TBA_BASE_URL}${endpoint}`, {
      headers: { 'X-TBA-Auth-Key': TBA_API_KEY }
    });
    return response.data;
  } catch (error) {
    console.error(`Error fetching TBA data for ${endpoint}:`, error.response?.status, error.response?.data);
    throw error;
  }
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const calculateMedian = (scores) => {
  if (!scores.length) return 0;
  const sorted = scores.sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const formatMatchKey = (matchKey) => {
  const [eventPart, matchPart] = matchKey.split('_');
  const year = eventPart.slice(0, 4);
  const eventCode = eventPart.slice(4);
  const formattedEvent = eventCode.charAt(0).toUpperCase() + eventCode.slice(1).toLowerCase();
  const matchType = matchPart.slice(0, 2);
  const matchDetails = matchPart.slice(2);
  const types = { 'qm': 'Qualifier', 'qf': 'Quarterfinal', 'sf': 'Semifinal', 'f1': 'Final' };

  if (['qf', 'sf', 'f'].includes(matchType) && matchDetails.includes('m')) {
    const setNumber = matchDetails.split('m')[0];
    return `${formattedEvent} ${types[matchType]} ${setNumber}`;
  }
  return `${formattedEvent} ${types[matchType] || matchType} ${matchDetails}`;
};

const getMatchNumber = (matchKey) => {
  const matchPart = matchKey.split('_')[1];
  return matchPart.startsWith('qm')
    ? parseInt(matchPart.replace('qm', ''), 10)
    : parseInt(matchPart.match(/\d+$/)[0], 10);
};

const getTeamMedian = async (team, year, cache = {}) => {
  if (cache[team]) return cache[team];
  const matches = await fetchTBA(`/team/${team}/matches/${year}/simple`);
  const scores = matches
    .filter(m => m.alliances.red.score !== -1 && m.alliances.blue.score !== -1)
    .map(m => m.alliances.red.team_keys.includes(team) ? m.alliances.red.score : m.alliances.blue.score);
  const median = calculateMedian(scores);
  cache[team] = median;
  return median;
};

const processMatchResults = (matches, teamKey, eventMap) => {
  const teamScores = [];
  let wins = 0, losses = 0, ties = 0;
  const matchResults = [];

  matches.sort((a, b) => {
    const aTime = a.actual_time || a.predicted_time || a.time || 0;
    const bTime = b.actual_time || b.predicted_time || b.time || 0;
    
    if (aTime && bTime) {
      return aTime - bTime;
    } else {
      const aNum = getMatchNumber(a.key);
      const bNum = getMatchNumber(b.key);
      return aNum - bNum;
    }
  });

  for (const match of matches) {
    if (match.alliances.red.score === -1 || match.alliances.blue.score === -1) continue;

    const { red, blue } = match.alliances;
    const teamInRed = red.team_keys.includes(teamKey);
    const teamInBlue = blue.team_keys.includes(teamKey);
    const allianceScore = teamInRed ? red.score : blue.score;
    teamScores.push(allianceScore);

    const result = red.score > blue.score ? (teamInRed ? 'Win' : 'Loss') :
                   red.score < blue.score ? (teamInBlue ? 'Win' : 'Loss') : 'Tie';
    if (result === 'Win') wins++;
    else if (result === 'Loss') losses++;
    else ties++;

    matchResults.push({
      event: eventMap[match.event_key] || "Unknown Event",
      matchKey: formatMatchKey(match.key),
      redScore: red.score,
      blueScore: blue.score,
      result,
      alliance: teamInRed ? 'Red' : 'Blue',
      rawKey: match.key,
      score: allianceScore
    });
  }

  return { teamScores, wins, losses, ties, matchResults };
};

const predictMatchOutcome = async (match, year, teamMedianCache) => {
  const { red, blue } = match.alliances;
  const redMedians = await Promise.all(red.team_keys.map(team => getTeamMedian(team, year, teamMedianCache)));
  const blueMedians = await Promise.all(blue.team_keys.map(team => getTeamMedian(team, year, teamMedianCache)));
  const redAllianceMedian = calculateMedian(redMedians);
  const blueAllianceMedian = calculateMedian(blueMedians);

  return {
    matchKey: formatMatchKey(match.key),
    redTeams: red.team_keys.join(', '),
    blueTeams: blue.team_keys.join(', '),
    redMedian: redAllianceMedian.toFixed(2),
    blueMedian: blueAllianceMedian.toFixed(2),
    predictedWinner: redAllianceMedian > blueAllianceMedian ? 'Red' : 'Blue'
  };
};

const estimateQueuingTime = async (eventKey, futureMatches, currentDate) => {
  try {
    const matches = await fetchTBA(`/event/${eventKey}/matches/simple`);
    const completedMatches = matches
      .filter(m => m.actual_time && m.alliances.red.score !== -1 && m.alliances.blue.score !== -1)
      .sort((a, b) => a.actual_time - b.actual_time);

    const MIN_MATCH_INTERVAL = 20000;
    const avgTimeBetweenMatches = completedMatches.length < 2
      ? MIN_MATCH_INTERVAL
      : Math.max(
        calculateMedian(completedMatches.slice(1).map((m, i) =>
          (m.actual_time * 1000) - (completedMatches[i].actual_time * 1000)
        ).filter(diff => diff > 0)),
        MIN_MATCH_INTERVAL
      );

    const lastMatch = completedMatches[completedMatches.length - 1] || { time: currentDate / 1000 };
    const lastMatchTime = new Date((lastMatch.actual_time || lastMatch.time) * 1000);
    const lastMatchNumber = lastMatch ? getMatchNumber(lastMatch.key) : 0;

    return futureMatches.map(match => {
      const matchNumber = getMatchNumber(match.key);
      const matchGap = matchNumber - lastMatchNumber;
      const estimatedTime = new Date(lastMatchTime.getTime() + matchGap * avgTimeBetweenMatches);
      const timeUntil = Math.round((estimatedTime - currentDate) / (1000 * 60));
      return {
        matchKey: formatMatchKey(match.key),
        estimatedTime: estimatedTime.toLocaleString(),
        timeUntil: timeUntil >= 0 ? `${timeUntil} minutes` : 'Match may have started'
      };
    });
  } catch (error) {
    console.error('Error estimating queuing time:', error);
    return futureMatches.map(match => ({
      matchKey: formatMatchKey(match.key),
      timeUntil: 'Not available yet'
    }));
  }
};

const fetchStatboticsRank = async (teamNumber, year) => {
  try {
    const response = await axios.get(`https://api.statbotics.io/v3/team_year/${teamNumber}/${year}`);
    return response.data.epa?.ranks?.total?.rank || 'N/A';
  } catch (error) {
    console.error(`Error fetching Statbotics rank for team ${teamNumber}:`, error);
    return 'N/A';
  }
};

const fetchAllTeams = async (year) => {
  let allTeams = [];
  let page = 0;
  let teams;

  do {
    teams = await fetchTBA(`/teams/${year}/${page}/simple`);
    allTeams = allTeams.concat(teams);
    console.log(`Fetched ${teams.length} teams from page ${page}`);
    page++;
    await delay(1000);
  } while (teams.length > 0);

  return allTeams;
};

const generateLeaderboard = async () => {
  try {
    const year = new Date().getFullYear();
    const teams = await fetchAllTeams(year);
    const leaderboard = [];

    console.log(`Generating leaderboard for ${teams.length} teams...`);

    for (const team of teams) {
      const teamKey = team.key;
      const matches = await fetchTBA(`/team/${teamKey}/matches/${year}/simple`);
      const { wins, losses, ties } = processMatchResults(matches, teamKey, {});

      const totalMatches = wins + losses + ties;
      const winLossRatio = totalMatches > 0 ? (wins / (wins + losses) || 0) : 0;

      leaderboard.push({
        teamNumber: team.team_number,
        teamName: team.nickname || `Team ${team.team_number}`,
        wins,
        losses,
        ties,
        winLossRatio: winLossRatio.toFixed(3),
        totalMatches
      });

      await delay(200);
    }

    leaderboard.sort((a, b) => b.winLossRatio - a.winLossRatio);
    const top250 = leaderboard.slice(0, 250);

    top250.forEach((team, index) => {
      team.rank = index + 1;
    });

    await fs.writeFile('leaderboard.json', JSON.stringify(top250, null, 2));
    console.log('Leaderboard generated and saved to leaderboard.json (top 250 teams)');
  } catch (error) {
    console.error('Error generating leaderboard:', error);
  }
};

cron.schedule('0 0 * * *', () => {
  console.log('Running daily leaderboard refresh...');
  generateLeaderboard();
});

app.get('/api/leaderboard', async (req, res) => {
  try {
    const leaderboard = await fs.readFile('leaderboard.json', 'utf8');
    res.json(JSON.parse(leaderboard));
  } catch (error) {
    console.error('Error reading leaderboard:', error);
    res.status(500).json({ error: 'Leaderboard not available yet' });
  }
});

app.get('/leaderboard', (req, res) => {
  res.render('leaderboard', { year: new Date().getFullYear() });
});

app.get('/review/:teamNumber', async (req, res) => {
  const teamNumber = req.params.teamNumber;
  const teamKey = `frc${teamNumber}`;
  const year = req.query.year || new Date().getFullYear();
  const currentDate = new Date();

  try {
    const [years, matches, events, team, globalRank] = await Promise.all([
      fetchTBA(`/team/${teamKey}/years_participated`),
      fetchTBA(`/team/${teamKey}/matches/${year}/simple`),
      fetchTBA(`/team/${teamKey}/events/${year}/simple`),
      fetchTBA(`/team/${teamKey}/simple`),
      fetchStatboticsRank(teamNumber, year)
    ]);

    const eventMap = Object.fromEntries(events.map(event => [event.key, event.name]));
    const { teamScores, wins, losses, ties, matchResults } = processMatchResults(matches, teamKey, eventMap);
    
    const teamMedianPoints = calculateMedian(teamScores);
    const totalMatches = wins + losses + ties;
    const winPercentage = totalMatches > 0 ? ((wins / totalMatches) * 100).toFixed(2) + '%' : 'N/A';

    const futureMatches = matches.filter(m => {
      const matchTime = new Date((m.predicted_time || m.time || Infinity) * 1000);
      return matchTime > currentDate && m.alliances.red.score === -1 && m.alliances.blue.score === -1;
    });

    const teamMedianCache = {};
    const predictions = await Promise.all(futureMatches.slice(0, 5).map(match => 
      predictMatchOutcome(match, year, teamMedianCache)
    ));
    const queuingEstimates = futureMatches.length > 0 
      ? await estimateQueuingTime(futureMatches[0].event_key, futureMatches, currentDate) 
      : [];

    res.render('review', {
      teamNumber,
      teamName: team.nickname || `Team ${teamNumber}`,
      year,
      yearsParticipated: years,
      message: matches.length === 0 ? `No matches found for Team ${teamNumber} in ${year}.` : null,
      teamMedianPoints: teamMedianPoints.toFixed(2),
      wins,
      losses,
      ties,
      winPercentage,
      matches: matchResults,
      predictions,
      queuingEstimates,
      matchScores: matchResults.map(m => ({ label: m.matchKey, score: m.score })),
      globalRank
    });
  } catch (error) {
    console.error(error);
    res.render('review', {
      teamNumber,
      teamName: `Team ${teamNumber}`,
      year,
      yearsParticipated: [],
      message: 'Error fetching data from The Blue Alliance.',
      teamMedianPoints: null,
      winPercentage: null,
      matches: [],
      predictions: [],
      queuingEstimates: [],
      matchScores: [],
      globalRank: 'N/A'
    });
  }
});

app.get('/predictor', (req, res) => res.render('predictor', { prediction: null, error: null }));

app.post('/predictor', async (req, res) => {
  try {
    const { red1, red2, red3, blue1, blue2, blue3 } = req.body;
    const redTeams = [red1, red2, red3].map(num => `frc${num}`);
    const blueTeams = [blue1, blue2, blue3].map(num => `frc${num}`);
    const year = new Date().getFullYear();

    const [redMedians, blueMedians] = await Promise.all([
      Promise.all(redTeams.map(team => getTeamMedian(team, year))),
      Promise.all(blueTeams.map(team => getTeamMedian(team, year)))
    ]);

    const [redAllianceMedian, blueAllianceMedian] = [calculateMedian(redMedians), calculateMedian(blueMedians)];
    const predictedWinner = redAllianceMedian > blueAllianceMedian ? 'Red' : 'Blue';
    const winProbability = Math.round((Math.max(redAllianceMedian, blueAllianceMedian) /
      (redAllianceMedian + blueAllianceMedian)) * 100);

    res.render('predictor', {
      prediction: {
        redTeams: redTeams.map(t => t.replace('frc', '')),
        blueTeams: blueTeams.map(t => t.replace('frc', '')),
        redMedian: redAllianceMedian.toFixed(2),
        blueMedian: blueAllianceMedian.toFixed(2),
        predictedWinner,
        winProbability
      },
      error: null
    });
  } catch (error) {
    console.error(error);
    res.render('predictor', {
      prediction: null,
      error: 'Error processing prediction. Please check team numbers and try again.'
    });
  }
});

app.get('/api/events', async (req, res) => {
  try {
    const year = req.query.year || new Date().getFullYear();
    const events = await fetchTBA(`/events/${year}/simple`);
    res.json(events);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch events' });
  }
});

app.get('/compare', (req, res) => res.render('compare', { commonTeams: null, event1: null, event2: null, error: null }));

app.post('/compare', async (req, res) => {
  const { event1, event2 } = req.body;
  try {
    const [teams1, teams2, event1Details, event2Details] = await Promise.all([
      fetchTBA(`/event/${event1}/teams/simple`),
      fetchTBA(`/event/${event2}/teams/simple`),
      fetchTBA(`/event/${event1}/simple`),
      fetchTBA(`/event/${event2}/simple`)
    ]);

    const event1Teams = new Set(teams1.map(team => team.team_number));
    const commonTeamNumbers = teams2.map(team => team.team_number)
      .filter(team => event1Teams.has(team))
      .sort((a, b) => a - b);

    const commonTeams = await Promise.all(commonTeamNumbers.map(async teamNumber => {
      const [team, media] = await Promise.all([
        fetchTBA(`/team/frc${teamNumber}/simple`),
        fetchTBA(`/team/frc${teamNumber}/media/2025`)
      ]);
      const avatar = media.find(m => m.type === 'avatar');
      return {
        number: teamNumber,
        name: team.nickname || 'Unknown Team',
        avatar: avatar?.details?.base64Image ? `data:image/png;base64,${avatar.details.base64Image}` : null
      };
    }));

    res.render('compare', { commonTeams, event1: event1Details, event2: event2Details, error: null });
  } catch (error) {
    console.error(error);
    res.render('compare', {
      commonTeams: null,
      event1: null,
      event2: null,
      error: 'Error fetching event or team data. Please try again.'
    });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
  generateLeaderboard();
});