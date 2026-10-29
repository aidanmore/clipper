import https from 'node:https';
import dns from 'node:dns';
import ipaddr from 'ipaddr.js';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { fail, text } from './domain.js';
export function publicAddress(address) {
  try {
    return ipaddr.process(address).range() === 'unicast';
  } catch {
    return false;
  }
}
export function remoteUrl(value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    fail('Enter a valid HTTPS feed or audio URL.');
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443'))
    fail('Use a public HTTPS URL on port 443 without credentials.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) && !publicAddress(host)) fail('Private network URLs are not allowed.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local'))
    fail('Private network URLs are not allowed.');
  return u;
}
// Validate at connection time, not just before fetch, to prevent DNS rebinding.
export function lookup(host, opts, callback) {
  dns.lookup(host, { all: true }, (error, records) => {
    if (error) return callback(error);
    if (!records.length || records.some((r) => !publicAddress(r.address)))
      return callback(new Error('Private network destination blocked.'));
    callback(
      null,
      opts.all ? records : records[0].address,
      opts.all ? undefined : records[0].family,
    );
  });
}
export async function remoteStream(value, redirects = 0) {
  const u = remoteUrl(value);
  if (redirects > 5) fail('Too many redirects.');
  const response = await new Promise((resolve, reject) => {
    const req = https.get(
      u,
      { lookup, agent: false, headers: { 'User-Agent': 'YellowFiveClipper/2.0', Accept: '*/*' } },
      resolve,
    );
    req.setTimeout(30000, () => req.destroy(new Error('Source stopped responding.')));
    req.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    if (!response.headers.location) fail('Invalid source redirect.');
    return remoteStream(new URL(response.headers.location, u).href, redirects + 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    fail(`Source returned HTTP ${response.statusCode}.`);
  }
  return response;
}
export async function remoteText(url, max = 5 * 1024 * 1024) {
  const response = await remoteStream(url);
  const parts = [];
  let count = 0;
  for await (const chunk of response) {
    count += chunk.length;
    if (count > max) {
      response.destroy();
      fail('Source response is too large.');
    }
    parts.push(chunk);
  }
  return Buffer.concat(parts).toString('utf8');
}
export async function download(url, path, maxBytes) {
  const response = await remoteStream(url);
  let bytes = 0;
  await pipeline(
    response,
    new Transform({
      transform(chunk, encoding, cb) {
        bytes += chunk.length;
        cb(bytes > maxBytes ? new Error('Episode exceeds the file size limit.') : null, chunk);
      },
    }),
    createWriteStream(path),
  );
  return bytes;
}
export function parseFeed(xml, feedUrl) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true)
    fail('This is not a valid podcast RSS feed.');
  const parsed = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    processEntities: true,
    parseTagValue: false,
  }).parse(xml);
  const channel = parsed.rss?.channel;
  if (!channel) fail('This URL does not contain a podcast RSS channel.');
  const string = (value) => (typeof value === 'object' ? value?.['#text'] || '' : value || '');
  const art = channel['itunes:image']?.['@_href'] || channel.image?.url || '';
  const entries = channel.item ? (Array.isArray(channel.item) ? channel.item : [channel.item]) : [];
  return {
    title: text(string(channel.title)),
    feedUrl,
    episodes: entries.slice(0, 300).flatMap((item) => {
      const enclosure = Array.isArray(item.enclosure) ? item.enclosure[0] : item.enclosure;
      if (!enclosure?.['@_url']) return [];
      let url;
      try {
        url = remoteUrl(enclosure['@_url']).href;
      } catch {
        return [];
      }
      return [
        {
          title: text(string(item.title)),
          sourceUrl: url,
          sourceKey: `${feedUrl}#${text(string(item.guid) || url, 2000)}`,
          artwork: text(item['itunes:image']?.['@_href'] || art, 2000),
          date: text(string(item.pubDate)),
          duration: text(string(item['itunes:duration'])),
        },
      ];
    }),
  };
}
