const bcrypt = require('bcryptjs');
const hash = process.argv[2];
const candidates = ['password', 'admin', 'admin123', 'admindash', '123456', 'admin2026', 'fresh_password_2026', 'Academify@2026', 'Admin@123', 'admin@123', 'password123', 'accounting', 'admin@academify.com'];

(async () => {
  for (const c of candidates) {
    let ok = false;
    try { ok = await bcrypt.compare(c, hash); } catch (e) { console.log('compare threw for', c, e.message); }
    if (ok) console.log('MATCH: "' + c + '"');
  }
  console.log('done');
})();