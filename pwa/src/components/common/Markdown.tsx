import { marked } from 'marked';

const ALLOWED_TAGS = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'ul',
]);

function escapeRawHtml(src: string): string {
  return src
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;');
}

function isSafeHref(href: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const url = new URL(href, window.location.origin);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function sanitizeHtml(html: string): string {
  if (typeof document === 'undefined') return html;

  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, NodeFilter.SHOW_ELEMENT);
  const elements: Element[] = [];
  let node = walker.nextNode();
  while (node) {
    elements.push(node as Element);
    node = walker.nextNode();
  }

  for (const element of elements) {
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      element.replaceWith(document.createTextNode(element.textContent ?? ''));
      continue;
    }

    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (tag === 'a' && name === 'href') {
        if (!isSafeHref(attribute.value)) element.removeAttribute(attribute.name);
        continue;
      }
      if (tag === 'a' && name === 'title') continue;
      if (tag === 'ol' && name === 'start' && /^\d+$/.test(attribute.value)) continue;
      element.removeAttribute(attribute.name);
    }
  }

  return template.innerHTML;
}

export function Markdown({ src }: { src: string }) {
  const html = sanitizeHtml(marked(escapeRawHtml(src), { breaks: true }) as string);
  return <div className="detail-markdown" dangerouslySetInnerHTML={{ __html: html }} />;
}
