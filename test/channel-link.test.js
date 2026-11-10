import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { formatMetadataLine } from '../lib/video-metadata.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const helper = read('lib/channel-link.js');
const context = { URL };
runInNewContext(helper, context);
const { channelUrl } = context.YTRBGChannelLink;
const id = 'UC' + 'z'.repeat(22);
const origin = 'https://www.youtube.com';

test('channel links support API IDs, scraped paths, handles and legacy channels', () => {
  for (const [input, path] of [
    [id, '/channel/' + id],
    ['  ' + id + '  ', '/channel/' + id],
    ['/channel/' + id, '/channel/' + id],
    ['/channel/' + id + '/videos?view=0#top', '/channel/' + id],
    ['/@ARTEConcert', '/@ARTEConcert'],
    ['@boilerroom', '/@boilerroom'],
    ['/@boilerroom/streams?view=0', '/@boilerroom'],
    ['https://www.youtube.com/@boilerroom?si=tracking', '/@boilerroom'],
    ['http://youtube.com/c/BoilerRoom/', '/c/BoilerRoom'],
    ['https://m.youtube.com/user/ARTEConcert/videos', '/user/ARTEConcert'],
    ['/@音楽', '/@%E9%9F%B3%E6%A5%BD'],
    ['/@caf%C3%A9', '/@caf%C3%A9']
  ]) assert.equal(channelUrl(input), origin + path, input);
});

test('missing, malformed and unsafe channel references never become links', () => {
  for (const value of [
    undefined, null, {}, 42, '', ' ', 'ARTE Concert', 'UCshort',
    '/channel/' + id + 'extra', '/channel/not-a-channel', '/@', '/c/', '/user/',
    '/watch?v=abcdefghijk', '/redirect?q=https://example.com', '/feed/subscriptions',
    'javascript:alert(1)', 'data:text/html,hello', 'https://example.com/@channel',
    'https://youtube.com.example.com/@channel', '//example.com/@channel',
    'https://youtube.com@evil.com/@channel', 'https://user@youtube.com/@channel',
    'https://youtube.com:8443/@channel', 'ftp://youtube.com/@channel',
    '/@bad%2Fname', '/@bad%5Cname', '/@bad%00name', '/@bad%20name', '/@bad%zz'
  ]) assert.equal(channelUrl(value), '', String(value));
});

// Exercise the actual card renderers with a minimal DOM, without starting
// storage listeners or the Home mount loop. Browser navigation remains native.
class Element {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.textContent = '';
  }
  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
}
function renderers() {
  const opened = [];
  const context = {
    URL, formatMetadataLine,
    document: { createElement: tag => new Element(tag) },
    chrome: { tabs: { create: value => opened.push(value) } },
    YTRBGShortsVisibility: { formatDuration: () => '13:38' }
  };
  runInNewContext(helper, context);
  const home = read('home.js');
  const homeHelpers = home.slice(home.indexOf('  const node ='), home.indexOf('  function send('));
  const homeCard = home.slice(home.indexOf('  function card('), home.indexOf('  function updatePagination('));
  runInNewContext('(() => { let currentShortsProbeSource = null;\n' + homeHelpers + homeCard +
    '\nglobalThis.homeCard = card; })();', context);
  const popup = read('popup.js');
  runInNewContext(popup.slice(0, popup.indexOf('function renderCandidateRefreshStatus('))
    .replace(/^import .*;$/m, '') + '\nglobalThis.popupCard = renderVideo;', context);
  return { homeCard: context.homeCard, popupCard: context.popupCard, opened };
}
function find(element, className) {
  if (element.className === className) return element;
  for (const child of element.children) {
    const result = find(child, className);
    if (result) return result;
  }
}
const video = {
  id: 'abcdefghijk', title: 'Wamen - B.traits Sessions - ARTE Concert',
  channel: 'ARTE Concert', channelId: '/@ARTEConcert',
  url: origin + '/watch?v=abcdefghijk', thumbnail: '',
  metadataLine: '4.1K views', viewCount: 4100
};

test('Home channel is a separate native link, preserving video links and label', () => {
  const { homeCard, opened } = renderers();
  const card = homeCard(video);
  const channel = find(card, 'ytrbg-channel');
  assert.equal(channel.tagName, 'A');
  assert.equal(channel.href, origin + '/@ARTEConcert');
  assert.equal(channel.textContent, 'ARTE Concert');
  assert.equal(channel.parentElement, card);
  assert.equal(channel.target, undefined); // Normal same-tab Home navigation.
  assert.deepEqual(channel.listeners, {}); // No click handler overrides modifiers.
  assert.deepEqual(card.listeners, {}); // Channel clicks cannot launch a video.
  assert.equal(find(card, 'ytrbg-thumbnail').href, video.url);
  assert.equal(find(card, 'ytrbg-title').href, video.url);
  assert.deepEqual(opened, []);
});

test('popup channel is a safe native new-tab link, separate from video buttons', () => {
  const { popupCard, opened } = renderers();
  const card = popupCard({ ...video, channelId: id }, 0);
  const channel = find(card, 'channel-name');
  assert.equal(channel.tagName, 'A');
  assert.equal(channel.href, origin + '/channel/' + id);
  assert.equal(channel.target, '_blank');
  assert.equal(channel.rel, 'noopener noreferrer');
  assert.equal(channel.textContent, video.channel);
  assert.deepEqual(channel.listeners, {});
  assert.deepEqual(card.listeners, {});
  assert.equal(find(card, 'meta').children[1].textContent, ' · 4.1K views');
  assert.deepEqual(opened, []);
  find(card, 'video-title').listeners.click();
  find(card, 'thumb').listeners.click();
  assert.deepEqual(opened.map(item => item.url), [video.url, video.url]);
});

test('cards retain plain text when the channel reference is absent or unsafe', () => {
  const { homeCard, popupCard } = renderers();
  for (const channelId of [undefined, '', 'https://example.com/@channel', 'invalid']) {
    const item = { ...video, channelId };
    const homeChannel = find(homeCard(item), 'ytrbg-channel');
    const popupChannel = find(popupCard(item, 0), 'channel-name');
    assert.equal(homeChannel.tagName, 'DIV');
    assert.equal(popupChannel.tagName, 'SPAN');
    for (const channel of [homeChannel, popupChannel]) {
      assert.equal(channel.textContent, video.channel);
      assert.equal(channel.href, undefined);
    }
  }
  assert.equal(find(homeCard({ ...video, channel: '' }), 'ytrbg-channel').textContent,
    'Channel unavailable');
  assert.equal(find(popupCard({ ...video, channel: '', viewCount: undefined }, 0), 'meta').textContent,
    'YouTube');
});

test('shared helper loads before both card renderers and links have hover/focus styles', () => {
  const manifest = JSON.parse(read('manifest.json'));
  const scripts = manifest.content_scripts[0].js;
  assert.ok(scripts.indexOf('lib/channel-link.js') >= 0);
  assert.ok(scripts.indexOf('lib/channel-link.js') < scripts.indexOf('home.js'));
  const popup = read('popup.html');
  assert.ok(popup.indexOf('src="lib/channel-link.js"') < popup.indexOf('src="popup.js"'));
  assert.match(read('home.css'), /a\.ytrbg-channel:hover.*a\.ytrbg-channel:focus-visible/);
  assert.match(read('popup.css'), /a\.channel-name:hover.*a\.channel-name:focus-visible/);
});
