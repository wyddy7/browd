// Fixture sites for the broken-site robustness eval (see CASES.md).
// One plain-HTTP server; the site is chosen by the Host header. The runner maps every *.test
// host here with Chromium's --host-resolver-rules, so the agent sees ordinary-looking URLs.
//   node fixtures.mjs [--port 8765] [--admin-port 8766]
// Admin: GET http://127.0.0.1:<admin-port>/reset clears per-run state (flaky counters).
import http from 'node:http';
import { CODES } from './codes.mjs';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const PORT = Number(arg('port', 8765));
const ADMIN_PORT = Number(arg('admin-port', 8766));

let state = {};
const resetState = () => {
  state = { springSaleHits: 0 };
};
resetState();

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const page = (title, body) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
const send = (res, html, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
};
const notFound = res => send(res, page('Not found', '<h1>404 — page not found</h1>'), 404);
// Drop the TCP connection without a response: the tab lands on a browser error page.
const reset = req => req.socket.destroy();
// Accept the request and never answer.
const hang = () => {};
const delay = ms => new Promise(r => setTimeout(r, ms));

const sites = {
  // --- broken -----------------------------------------------------------------------------
  'cityhall.test': req => reset(req),
  'gadgetshop.test': () => hang(),
  'weather.test': req => reset(req),
  'www.weather.test': () => hang(),
  'healthinfo.test': (req, res) =>
    send(
      res,
      page(
        'Access Denied',
        `<h1>Access Denied</h1><p>You don't have permission to access "http://healthinfo.test${esc(req.url)}" on this server.</p><p>Reference #18.4f2a1b17.1759312331.9c1e02</p>`,
      ),
      403,
    ),
  'transit.test': (req, res, url) => {
    if (url.pathname === '/app.js') return hang(); // the bundle never arrives, the shell stays empty
    send(res, `<!doctype html><html><head><title>Transit</title><script async src="/app.js"></script></head><body><div id="root"></div></body></html>`);
  },
  'homegoods.test': (req, res, url) => {
    if (url.pathname === '/') {
      return send(
        res,
        page(
          'HomeGoods',
          `<h1>HomeGoods</h1><form action="/search"><input name="q" placeholder="Search products"><button>Search</button></form>
           <h2>Lighting</h2><ul><li><a href="/p/aurora-2">Aurora 2 desk lamp</a></li><li><a href="/p/beam-mini">Beam Mini clip light</a></li></ul>`,
        ),
      );
    }
    if (url.pathname === '/search') {
      return send(
        res,
        page(
          'Search — HomeGoods',
          `<h1>Results for “${esc(url.searchParams.get('q') || '')}”</h1><ul><li><a href="/p/aurora-2">Aurora 2 desk lamp</a> — see product page for price</li><li><a href="/p/aurora-1">Aurora desk lamp (discontinued)</a></li></ul>`,
        ),
      );
    }
    if (url.pathname.startsWith('/p/')) return reset(req); // every product page is dead
    return notFound(res);
  },
  'kitchenstore.test': (req, res, url) => {
    const blenders = [
      ['Zephyr X7 blender', '€89'],
      ['Zephyr X8 blender', '€109'],
      ['Nimbus Pro blender', '€149'],
    ];
    if (url.pathname === '/') {
      return send(
        res,
        page(
          'KitchenStore',
          `<h1>KitchenStore</h1><form action="/search"><input name="q" placeholder="Search"><button>Search</button></form>
           <h2>Blenders</h2><table>${blenders.map(([n, p]) => `<tr><td>${n}</td><td>${p}</td></tr>`).join('')}</table>`,
        ),
      );
    }
    if (url.pathname === '/search') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const hits = blenders.filter(([n]) => q && n.toLowerCase().includes(q));
      return send(
        res,
        page(
          'Search — KitchenStore',
          hits.length
            ? `<ul>${hits.map(([n, p]) => `<li>${n} — ${p}</li>`).join('')}</ul>`
            : `<p>No results for “${esc(url.searchParams.get('q') || '')}”.</p>`,
        ),
      );
    }
    return notFound(res);
  },
  'furniture.test': (req, res, url) => {
    const n = Number(url.searchParams.get('page') || 1);
    const pages = {
      1: ['Grey 3-seat sofa — code FN-2210', 'Oak coffee table — code FN-1180'],
      2: ['Blue 2-seat sofa — code FN-2305', 'Walnut bookshelf — code FN-4410'],
      3: ['Beige armchair — code FN-3120', 'Blue ottoman — code FN-3390'],
    };
    const items = pages[n] || pages[1];
    const next = n >= 3 ? 1 : n + 1; // «Next» on the last page leads back to page 1
    send(
      res,
      page(
        `Listings — page ${n}`,
        `<h1>Furniture listings</h1><p>Page ${n}</p><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul><a href="/?page=${next}">Next</a>`,
      ),
    );
  },

  // --- working ----------------------------------------------------------------------------
  'hostel.test': (req, res) =>
    send(
      res,
      page(
        'Hostel',
        `<h1>City Hostel — rooms</h1><table><tr><th>Room</th><th>Booking code</th></tr>${[10, 11, 12, 13]
          .map(r => `<tr><td>Room ${r}</td><td>${r === 12 ? CODES.plain : `HB-${r}0${r}`}</td></tr>`)
          .join('')}</table>`,
      ),
    ),
  'outdoorgear.test': async (req, res, url) => {
    if (url.pathname === '/') {
      return send(res, page('OutdoorGear', `<h1>OutdoorGear</h1><p><a href="/order-codes">Product order codes</a></p>`));
    }
    if (url.pathname === '/order-codes') {
      await delay(35_000);
      return send(
        res,
        page(
          'Order codes',
          `<h1>Order codes</h1><ul><li>Bergen daypack — OG-1104</li><li>Oslo backpack — ${CODES['slow-35s']}</li><li>Tromsø duffel — OG-3371</li></ul>`,
        ),
      );
    }
    return notFound(res);
  },
  'bookstore.test': (req, res, url) => {
    if (url.pathname === '/') {
      return send(res, page('Bookstore', `<h1>Corner Bookstore</h1><p><a href="/spring-sale">Spring sale</a></p>`));
    }
    if (url.pathname === '/spring-sale') {
      if (state.springSaleHits++ === 0) return reset(req); // the first visit fails, later ones work
      return send(res, page('Spring sale', `<h1>Spring sale</h1><p>Use voucher code <b>${CODES['flaky-first']}</b> at checkout.</p>`));
    }
    return notFound(res);
  },
  'secondhand.test': (req, res, url) => {
    const n = Math.min(8, Math.max(1, Number(url.searchParams.get('page') || 1)));
    const colours = ['red', 'black', 'white', 'brown', 'yellow', 'grey'];
    const kinds = ['chair', 'stool', 'bench', 'lamp'];
    const items = [];
    for (let i = 0; i < 12; i++) {
      const id = (n - 1) * 12 + i;
      items.push(`${colours[id % colours.length]} ${kinds[id % kinds.length]} — code SH-${String(5000 + id * 7)}`);
    }
    if (n === 6) items[7] = `green armchair — code ${CODES['pagination-6']}`;
    send(
      res,
      page(
        `Second-hand listings — page ${n} of 8`,
        `<h1>Second-hand listings</h1><p>Page ${n} of 8</p><ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>${n < 8 ? `<a href="/?page=${n + 1}">Next</a>` : ''}`,
      ),
    );
  },
  'hardware.test': (req, res) => {
    const rows = [];
    for (let i = 1; i <= 6000; i++) {
      const d = 3 + (i % 9);
      const l = 10 + ((i * 7) % 90);
      const code = i === 4812 ? CODES['heavy-dom'] : `HW-${String(100000 + i * 13)}`;
      rows.push(`<tr><td>${i}</td><td>M${i === 4812 ? '7x45' : `${d}x${l}`}</td><td>${code}</td></tr>`);
    }
    send(res, page('Hardware parts', `<h1>Bolt catalogue</h1><table><tr><th>#</th><th>Size</th><th>Part code</th></tr>${rows.join('')}</table>`));
  },
  'shoes.test': (req, res, url) => {
    const boots = [
      { slug: 'fjell-trail-wp', name: 'Fjell Trail WP', wp: true, price: 114, sizes: [40, 41, 42, 43, 44, 45, 46], code: CODES['long-flow'] },
      { slug: 'summit-pro-gtx', name: 'Summit Pro GTX', wp: true, price: 135, sizes: [41, 42, 43, 44, 45], code: 'SB-7730' },
      { slug: 'ridge-light-wp', name: 'Ridge Light WP', wp: true, price: 109, sizes: [38, 39, 40, 41, 42], code: 'SB-6612' },
      { slug: 'meadow-walker', name: 'Meadow Walker', wp: false, price: 89, sizes: [42, 43, 44, 45], code: 'SB-5521' },
      { slug: 'crag-hiker-wp', name: 'Crag Hiker WP', wp: true, price: 119, sizes: [36, 37, 38, 39], code: 'SB-8841' },
    ];
    if (url.pathname === '/') {
      return send(res, page('Shoes', `<h1>Shoes</h1><nav><a href="/sneakers">Sneakers</a> · <a href="/boots">Hiking boots</a> · <a href="/sandals">Sandals</a></nav>`));
    }
    if (url.pathname === '/boots') {
      const wp = url.searchParams.get('wp') === '1';
      const size = Number(url.searchParams.get('size') || 0);
      const max = Number(url.searchParams.get('max') || 0);
      const hits = boots.filter(b => (!wp || b.wp) && (!size || b.sizes.includes(size)) && (!max || b.price <= max));
      return send(
        res,
        page(
          'Hiking boots',
          `<h1>Hiking boots</h1>
           <form action="/boots"><label><input type="checkbox" name="wp" value="1"${wp ? ' checked' : ''}> Waterproof</label>
           <label>Size <select name="size"><option value="">any</option>${[36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46]
             .map(s => `<option${s === size ? ' selected' : ''}>${s}</option>`)
             .join('')}</select></label>
           <label>Max price € <input name="max" value="${max || ''}"></label><button>Filter</button></form>
           <ul>${hits.map(b => `<li><a href="/boots/${b.slug}">${b.name}</a> — €${b.price}</li>`).join('') || '<li>No boots match.</li>'}</ul>`,
        ),
      );
    }
    const b = boots.find(x => url.pathname === `/boots/${x.slug}`);
    if (b) {
      return send(
        res,
        page(
          b.name,
          `<h1>${b.name}</h1><p>Price: €${b.price}</p><p>${b.wp ? 'Waterproof membrane.' : 'Breathable mesh, not waterproof.'}</p><p>Sizes in stock: ${b.sizes.join(', ')}</p><p>Product code: ${b.code}</p>`,
        ),
      );
    }
    if (url.pathname === '/sneakers' || url.pathname === '/sandals') return send(res, page('Coming soon', '<p>Coming soon.</p>'));
    return notFound(res);
  },
};

http
  .createServer((req, res) => {
    const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    const handler = sites[host];
    if (!handler) return send(res, page('Unknown host', `<p>No fixture for ${esc(host)}</p>`), 421);
    Promise.resolve(handler(req, res, new URL(req.url, `http://${host}`))).catch(e => {
      if (!res.headersSent) send(res, page('Error', `<pre>${esc(e.stack)}</pre>`), 500);
    });
  })
  .listen(PORT, '127.0.0.1', () => console.log(`fixtures on 127.0.0.1:${PORT}`));

http
  .createServer((req, res) => {
    if (req.url === '/reset') {
      resetState();
      res.end('ok');
    } else res.writeHead(404).end();
  })
  .listen(ADMIN_PORT, '127.0.0.1', () => console.log(`admin on 127.0.0.1:${ADMIN_PORT}`));
