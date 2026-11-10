"use strict";

const Y5Tags = (() => {
  const base = ["yellow five", "yellow five podcast", "yllw5", "comedy podcast"];
  const stop = new Set((
    "a about above actually after again against ah all almost already also am an and any are around as at away " +
    "back basically be because been before being below best better big both but by call came can cant come could " +
    "day did do does doing dont down dude each else end enough even ever every exactly far feel few first for " +
    "from fuck fucking full get getting give go going gone gonna good got guess guy guys had has have having he " +
    "her here hey him his how i if im in inside into is it its just keep kind know last least let lets like liked likes " +
    "little listener look looking lot literally made make man many may maybe mean might mine more most much must my near " +
    "need never new next no nobody not nothing now of off oh okay old on once one only onto or other our out over " +
    "own part people place play played playing pretty probably put quite really right said same say saying see " +
    "seem seen she shit should show since so some somebody something sometimes sort still stuff such sure take talk talking " +
    "tell than that thats the their them then there these they thing things think this those though thought through " +
    "time times to today together too took totally try two uh um under until up upon us use used very wait want " +
    "was way we well went were what whatever when where whether which while who whole why will with without " +
    "won would wow yeah year yes you your youre youve"
  ).split(/\s+/));
  const connectors = new Set(["of", "the", "in"]);
  const weak = new Set(["episode", "podcast", "comedy", "yellow", "five", "way", "story", "world", "video",
    "game", "music", "movie", "movies", "today", "whatever", "laughs", "laughter", "applause", "okay"]);
  const wordPattern = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
  const keyFor = (word) => word.toLowerCase().replace(/[’']/g, "");
  const contentWord = (word) => {
    const key = keyFor(word);
    return key.length >= 2 && /\p{L}/u.test(key) && !stop.has(key) && !/n['’]t$/i.test(word);
  };
  const proper = (word) => /^\p{Lu}[\p{Ll}\p{M}]/u.test(word) || /^[A-Z][A-Z0-9]{1,9}$/.test(word);

  function split(text) {
    return text.replace(/([^.!?])\n+(?=\p{Ll})/gu, "$1 ")
      .split(/[\n,.!?;:\u2013\u2014]+/u).filter(Boolean);
  }

  function topics(transcript, title, description) {
    const candidates = new Map();
    const metadata = keyFor(title + " " + description);
    let wordsSeen = 0;
    for (const sentence of split(transcript.slice(0, 350000))) {
      const words = sentence.match(wordPattern) || [];
      const group = Math.floor(wordsSeen / 100);
      wordsSeen += words.length;
      for (let start = 0; start < words.length; start++) {
        if (!contentWord(words[start])) continue;
        if (start > 0 && proper(words[start]) && proper(words[start - 1]) && contentWord(words[start - 1])) continue;
        let names = 0;
        let significant = 0;
        let allGeneric = true;
        for (let end = start; end < Math.min(start + 5, words.length); end++) {
          const word = words[end];
          const key = keyFor(word);
          if (!contentWord(word)) {
            const next = words[end + 1] || "";
            const joinTwoNames = key === "and" && end === start + 1 &&
              proper(words[start]) && proper(next) && !proper(words[end + 2] || "");
            if (joinTwoNames || (connectors.has(key) && proper(words[start]))) continue;
            break;
          }
          significant++;
          if (proper(word)) names++;
          if (!weak.has(key)) allGeneric = false;
          if (allGeneric || (significant === 1 && (!names || (start === 0 && !/^[A-Z]{2,}$/.test(word))))) continue;
          const sentenceCase = start === 0 && names === 1 && proper(words[start]);
          if (names && names < significant && !sentenceCase) continue;
          if (proper(word) && proper(words[end + 1] || "") && contentWord(words[end + 1])) continue;
          const phrase = words.slice(start, end + 1).join(" ");
          if (phrase.length > 66) continue;
          const normalized = keyFor(phrase);
          const entry = candidates.get(normalized) ||
            { key: normalized, phrase, names: 0, significant, count: 0, groups: new Set() };
          entry.count++;
          entry.groups.add(group);
          if (names > entry.names && !sentenceCase) Object.assign(entry, { phrase, names });
          candidates.set(normalized, entry);
        }
      }
    }

    const ranked = [...candidates.values()].flatMap((entry) => {
      const backedByNotes = metadata.includes(entry.key) && entry.significant > 1;
      const spread = entry.groups.size;
      const discussedInOneSection = entry.count >= 2 &&
        (entry.names >= 2 || (entry.significant === 2 && entry.key.split(" ").length === 2));
      if (spread < 2 && !backedByNotes && !discussedInOneSection) return [];
      if (entry.significant === 1 && (spread < 3 || entry.count < 3)) return [];
      const score = Math.log2(1 + Math.min(spread, 25)) * 2.7 +
        Math.log2(1 + Math.min(entry.count, 40)) +
        (entry.significant > 1 ? 2.4 : 0) +
        Math.min(entry.names, 2) * 1.3 + (backedByNotes ? 2.5 : 0) -
        Math.max(0, entry.key.split(" ").length - 3) * 0.7;
      return [{ ...entry, score }];
    }).sort((a, b) => b.score - a.score || b.significant - a.significant || a.key.localeCompare(b.key));

    const selected = [];
    for (const entry of ranked) {
      if (selected.some((other) => (" " + other.key + " ").includes(" " + entry.key + " ") ||
                                   (" " + entry.key + " ").includes(" " + other.key + " "))) continue;
      selected.push(entry);
      if (selected.length === 12) break;
    }
    return selected.map(({ phrase, names }) => names ? phrase : phrase.toLowerCase());
  }

  function budget(tags) {
    return tags.reduce((sum, tag, index) => sum + [...tag].length + (/\s/.test(tag) ? 2 : 0) +
      (index ? 1 : 0), 0);
  }

  function splitTags(value) {
    return value.split(/[,\n]/).map((tag) => tag.trim()).filter(Boolean);
  }

  function suggest(title, description, transcript = "") {
    const episodeTitle = title.replace(/^[\u2080-\u2089\d\s#]+/u, "").replace(/[,<>"]/g, " ").trim();
    const specific = topics(transcript, title, description);
    const tags = [];
    const seen = new Set();
    for (const tag of [...base, ...specific, episodeTitle]) {
      const key = keyFor(tag);
      if (!tag || seen.has(key) || budget([...tags, tag]) > 500) continue;
      seen.add(key);
      tags.push(tag);
    }
    return { tags, topicCount: tags.filter((tag) => specific.includes(tag)).length };
  }

  return { budget, splitTags, suggest };
})();
