import { decodeString } from 'micromark-util-decode-string';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const markdownParser = unified().use(remarkParse).use(remarkGfm);

export function markdownLinkTargets(markdown) {
  if (typeof markdown !== 'string') throw new TypeError('markdown must be a string');
  const targets = [];
  visit(markdownParser.parse(markdown));
  return targets;

  function visit(node) {
    if (
      (node.type === 'link' || node.type === 'image' || node.type === 'definition')
      && typeof node.url === 'string'
    ) {
      targets.push({ raw: node.url, line: node.position?.start?.line ?? 1 });
    } else if (node.type === 'html' && typeof node.value === 'string') {
      targets.push(...htmlLinkTargets(node.value, node.position?.start?.line ?? 1));
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  }
}

export function relativeMarkdownLinkTargets(markdown) {
  const targets = [];
  for (const link of markdownLinkTargets(markdown)) {
    let target = link.raw.trim();
    if (
      target.length === 0
      || target === '...'
      || target.startsWith('#')
      || target.startsWith('/')
      || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu.test(target)
    ) continue;
    target = target.split(/[?#]/u, 1)[0];
    if (target.length === 0) continue;
    try {
      targets.push({ ...link, target: decodeURIComponent(target) });
    } catch {
      throw new TypeError(`Markdown target has invalid percent encoding: ${target}`);
    }
  }
  return targets;
}

function htmlLinkTargets(html, firstLine) {
  const targets = [];
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf('<', cursor);
    if (open === -1) break;
    cursor = open + 1;
    if (html.startsWith('!--', cursor)) {
      const close = html.indexOf('-->', cursor + 3);
      cursor = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html[cursor] === '/' || html[cursor] === '!' || html[cursor] === '?') {
      const close = tagEnd(html, cursor);
      cursor = close === -1 ? html.length : close + 1;
      continue;
    }

    const nameStart = cursor;
    while (/[A-Za-z0-9:-]/u.test(html[cursor] ?? '')) cursor += 1;
    if (cursor === nameStart) continue;
    const tagName = html.slice(nameStart, cursor).toLowerCase();
    const close = tagEnd(html, cursor);
    if (close === -1) break;
    const line = firstLine + html.slice(0, open).split('\n').length - 1;
    if (tagName === 'a' || tagName === 'img' || tagName === 'source') {
      for (const { name, value } of htmlAttributes(html, cursor, close)) {
        const accepted = tagName === 'a'
          ? name === 'href'
          : name === 'src' || name === 'srcset';
        if (!accepted) continue;
        const decoded = decodeHtmlCharacterReferences(value);
        if (name === 'srcset') {
          for (const raw of srcsetTargets(decoded)) targets.push({ raw, line });
        } else {
          targets.push({ raw: decoded, line });
        }
      }
    }
    cursor = close + 1;
  }
  return targets;
}

function htmlAttributes(html, start, end) {
  const attributes = [];
  let cursor = start;
  while (cursor < end) {
    while (/\s/u.test(html[cursor] ?? '')) cursor += 1;
    if (cursor >= end || html[cursor] === '/') break;
    const nameStart = cursor;
    while (!/[\s=/>]/u.test(html[cursor] ?? '>')) cursor += 1;
    const name = html.slice(nameStart, cursor).toLowerCase();
    while (/\s/u.test(html[cursor] ?? '')) cursor += 1;
    let value = '';
    if (html[cursor] === '=') {
      cursor += 1;
      while (/\s/u.test(html[cursor] ?? '')) cursor += 1;
      const quote = html[cursor] === '"' || html[cursor] === "'" ? html[cursor] : null;
      if (quote !== null) {
        const valueStart = ++cursor;
        while (cursor < end && html[cursor] !== quote) cursor += 1;
        value = html.slice(valueStart, cursor);
        if (html[cursor] === quote) cursor += 1;
      } else {
        const valueStart = cursor;
        while (cursor < end && !/[\s>]/u.test(html[cursor])) cursor += 1;
        value = html.slice(valueStart, cursor);
      }
    }
    if (name) attributes.push({ name, value });
  }
  return attributes;
}

function tagEnd(html, start) {
  let quote = null;
  for (let cursor = start; cursor < html.length; cursor += 1) {
    const character = html[cursor];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return cursor;
    }
  }
  return -1;
}

function decodeHtmlCharacterReferences(value) {
  return value.replace(
    /&(?:#(?:\d{1,7}|x[\da-f]{1,6})|[\da-z]{1,31});/giu,
    (reference) => decodeString(reference),
  );
}

function srcsetTargets(value) {
  const targets = [];
  let cursor = 0;
  while (cursor < value.length) {
    while (/[\s,]/u.test(value[cursor] ?? '')) cursor += 1;
    const start = cursor;
    while (cursor < value.length && !/\s/u.test(value[cursor])) cursor += 1;
    const token = value.slice(start, cursor);
    const target = token.replace(/,+$/u, '');
    if (target) targets.push(target);
    if (/,+$/u.test(token)) continue;
    while (cursor < value.length && value[cursor] !== ',') cursor += 1;
    if (value[cursor] === ',') cursor += 1;
  }
  return targets;
}
