'use strict';
// Test-only HTTP contract fixture. Real authentication/security behavior remains
// covered by PostgreSQL backend tests and the preserved cross-project integration.
const http = require('node:http');
const { randomBytes, randomUUID } = require('node:crypto');
function createAuthApiFixture() {
  const messages = [], sms = [], sessions = new Map(), credentials = new Map();
  const stats = { rotations: 0 };
  let user;
  function sessionFor(account, existing) {
    const session = existing || { user: account, revoked: false };
    const refreshToken = randomBytes(48).toString('base64url');
    const accessToken = randomBytes(32).toString('base64url');
    credentials.set(refreshToken, session); sessions.set(accessToken, session);
    return { user: account, refreshToken, accessToken, expiresIn: 900 };
  }
  const application = http.createServer(async (req, res) => {
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const reject = () => send(401, { error: { code: 'SESSION_INVALID', message: 'Session invalid.' } });
    try {
      let raw = '';
      for await (const chunk of req) { raw += chunk; if (raw.length > 32768) throw new Error('Body too large.'); }
      const body = raw ? JSON.parse(raw) : {};
      const current = sessions.get((req.headers.authorization || '').replace(/^Bearer /, ''));
      if (req.url === '/api/auth/signup') {
        user = { id: randomUUID(), username: body.username, displayName: body.username, email: body.email, emailVerified: false, phoneVerified: false };
        messages.push({ type: 'verification', code: '123456' });
        return send(201, sessionFor(user));
      }
      if (req.url === '/api/auth/refresh') {
        const session = credentials.get(body.refreshToken);
        if (!session || session.revoked) return reject();
        credentials.delete(body.refreshToken); stats.rotations++;
        return send(200, sessionFor(session.user, session));
      }
      if (req.url === '/api/auth/logout') {
        const session = credentials.get(body.refreshToken);
        if (session) session.revoked = true;
        return send(200, { ok: true });
      }
      if (req.url === '/api/auth/email/verify') {
        if (!current || current.revoked) return reject();
        if (body.code !== messages[0].code) return send(400, { error: { code: 'CODE_INVALID' } });
        current.user.emailVerified = true;
        return send(200, { ok: true });
      }
      if (req.url === '/api/users/me') {
        if (!current || current.revoked) return reject();
        return send(200, { user: current.user });
      }
      if (req.url === '/api/auth/password/forgot') {
        messages.push({ type: 'password_reset', code: '234567' });
        return send(200, { ok: true });
      }
      if (req.url === '/api/auth/password/reset') {
        if (body.code !== '234567') return send(400, { error: { code: 'CODE_INVALID' } });
        for (const session of sessions.values()) session.revoked = true;
        return send(200, { ok: true });
      }
      if (req.url === '/api/auth/phone/request-code') {
        sms.push({ phoneNumber: body.phoneNumber, code: '345678' });
        return send(200, { ok: true });
      }
      if (req.url === '/api/auth/phone/verify') {
        if (body.code !== '345678') return send(400, { error: { code: 'CODE_INVALID' } });
        return send(200, sessionFor({ id: randomUUID(), username: 'Phone_Test', displayName: 'Phone test', phoneNumber: body.phoneNumber, email: null, emailVerified: false, phoneVerified: true }));
      }
      return send(404, { error: { code: 'NOT_FOUND' } });
    } catch { return send(400, { error: { code: 'VALIDATION_FAILED' } }); }
  });
  application.locals = { emailService: { drain: async () => {} } };
  return { application, messages, sms, stats };
}
module.exports = { createAuthApiFixture };
