import assert from 'node:assert/strict';
import { publicUrl, searchWeb, readPages, ResearchError } from '../lib/research.ts';
import { demoAnswer } from '../lib/demo.ts';

for (const url of ['http://localhost/private', 'http://127.0.0.1/', 'http://169.254.169.254/', 'https://internal.local/', 'file:///etc/passwd', 'https://user:password@example.com/', 'https://example.com:8443/']) assert.equal(publicUrl(url), undefined);
assert.equal(publicUrl('https://example.com/article#part'), 'https://example.com/article');
const controller = new AbortController();
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (url, options) => {
    assert.equal(url, 'https://api.tavily.com/search');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(JSON.parse(options.body).query, 'a research question');
    return Response.json({results:[{title:'A source',url:'https://example.com/article',content:'Evidence'},{title:'Invalid',url:'javascript:alert(1)',content:'Bad'}]});
  };
  const sources = await searchWeb('a research question','test-key',controller.signal);
  assert.equal(sources.length,1);
  assert.equal(JSON.stringify(sources).includes('test-key'),false);
  globalThis.fetch = async () => Response.json({results:[],failed_results:[{url:sources[0].url}]});
  const partial=await readPages(sources,'test-key',controller.signal);
  assert.equal(partial.partial,true);
  assert.equal(partial.sources[0].read,undefined);
  assert.equal(partial.sources[0].content,'Evidence');
  globalThis.fetch = async () => Response.json({results:[{url:sources[0].url,raw_content:'Actual page content'}],failed_results:[]});
  const complete=await readPages(sources,'test-key',controller.signal);
  assert.equal(complete.partial,false);
  assert.equal(complete.sources[0].read,true);
  globalThis.fetch = async () => new Response('secret upstream message',{status:401});
  await assert.rejects(()=>searchWeb('test','test-key',controller.signal),error=>error instanceof ResearchError&&!error.message.includes('secret'));
} finally { globalThis.fetch=originalFetch; }
const unknown=demoAnswer('What happened in my city this morning?');
assert.equal(unknown.sources.length,0);
assert.match(unknown.text,/This is sample mode/);
assert.equal(demoAnswer('How do AI agents search the web?').sources.length,3);
console.log('Passed: URL restrictions, search contract, partial extraction, read labeling, credential error redaction, and honest demo fallback.');
