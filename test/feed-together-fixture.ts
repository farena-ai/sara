// E6: feed fixtures (synthetic feeds on invented example hosts) and an injected transport.
import type { TestContext } from 'node:test';
import { setNetTransport } from '../src/net-guard.ts';

export const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Heater Notes</title>
    <link>https://feeds.example.com/</link>
    <item>
      <title>Cleaning the filter &amp; more</title>
      <link>https://feeds.example.com/filter</link>
      <guid>tag:example,2026:filter</guid>
      <pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate>
      <description><![CDATA[<p>Rinse the filter <b>every month</b>.</p><script>alert(1)</script><img src="https://track.example.com/p.gif">]]></description>
      <content:encoded><![CDATA[<p>Rinse the filter <b>every month</b> in warm water.</p><script>steal()</script><p>Let it dry.</p>]]></content:encoded>
    </item>
    <item>
      <title>Storage</title>
      <link>javascript:alert(1)</link>
      <description>Store it upright.</description>
    </item>
  </channel>
</rss>`;

export const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Garden Log</title>
  <entry>
    <title>Tomatoes</title>
    <id>urn:uuid:1</id>
    <link rel="alternate" href="https://garden.example.org/tomatoes"/>
    <updated>2026-11-04T08:00:00Z</updated>
    <summary type="html">&lt;p&gt;Water them &lt;em&gt;early&lt;/em&gt;.&lt;/p&gt;</summary>
  </entry>
</feed>`;

export const RDF = `<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel rdf:about="https://old.example.net/"><title>Old News</title></channel>
  <item rdf:about="https://old.example.net/1"><title>First</title><link>https://old.example.net/1</link><dc:date>2026-11-01</dc:date><description>Plain words.</description></item>
</rdf:RDF>`;

export const PUBLIC = async () => ['93.184.216.34'];

export type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
/** An injected transport: answers by URL and records every request. */
export function stubNet(t: TestContext, handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  setNetTransport(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  });
  t.after(() => setNetTransport());
  return calls;
}
export const xml = (body: string, headers: Record<string, string> = {}) => new Response(body, { status: 200, headers: { 'content-type': 'application/rss+xml', ...headers } });
