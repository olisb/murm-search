const fs = require('fs');
const profiles = JSON.parse(fs.readFileSync(__dirname + '/../data/profiles.json','utf8'));

const stopwords = new Set(['the','and','for','are','but','not','you','all','can','has','her','was','one','our','out','his','how','its','may','who','did','get','let','say','she','too','use','with','that','this','from','they','been','have','many','some','them','than','each','make','like','into','over','such','find','here','what','about','which','when','there','their','will','would','could','should','projects','organisations','organizations','groups','initiatives','based','near','around','related']);

// "cambridge" should be caught as geo — check what extractTopicWords would produce
const geoAliasWords = new Set(['cambridge']); // simplified
const query = 'solar cambridge';
const topicWords = query.toLowerCase().split(/\s+/).filter(w => w.length >= 3 && !stopwords.has(w) && !geoAliasWords.has(w));
console.log('Topic words:', topicWords);

const names = ['Transition Cambridge', 'Daily Bread Co-operative (Cambridge)', 'Cambridge Journal of Economics', 'Cambridge Rugby Football Club', 'Vinery Road Permanent Allotment Society'];
for (const name of names) {
  const p = profiles.find(x => x.name === name);
  if (!p) { console.log(name, '- NOT FOUND'); continue; }
  const text = [p.name, p.description, ...(p.tags||[])].filter(Boolean).join(' ').toLowerCase();
  let matches = 0;
  for (const w of topicWords) {
    if (text.includes(w)) matches++;
  }
  const kwBoost = topicWords.length > 0 ? matches / topicWords.length : 0;
  console.log(name, '-> kwBoost:', kwBoost, '(matches:', matches, '/', topicWords.length, ')');
}
