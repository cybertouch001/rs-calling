// Help assistant matching: node --test test/help.test.mjs  (rule-based, no external service)
import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import vm from 'node:vm';
const sb = {}; sb.globalThis = sb; vm.createContext(sb); vm.runInContext(fs.readFileSync(new URL('../site/app/logic.js', import.meta.url), 'utf8'), sb); const H = sb.RSL.helpAnswer;
const LIVE = { min_duration: 45, repeat_hours: 12, call_rate: 3, lead_rate: 30, retention_days: 10, min_withdrawal: 250, withdraw_hours: 16, daily_target: 15, streak_bonus_7: 100, streak_bonus_30: 500, callback_counts: 0 };
const CASES = [
  ['how are my calls counted', 'counting'], ['call kaise count hoti hai', 'counting'], ['why was my call not counted', 'notcounted'], ['meri call count nahi hui', 'notcounted'], ['call gina nahi gaya kyu', 'notcounted'],
  ['how long should a call be', 'mindur'], ['how many seconds do I need to talk', 'mindur'], ['how much money do I get per call', 'rates'], ['paisa kitna milta hai per call', 'rates'],
  ['how to withdraw money', 'withdraw'], ['paisa kaise nikalna hai', 'withdraw'], ['when will I get my withdrawal', 'withdraw_time'], ['withdraw kab milega', 'withdraw_time'],
  ['what is the minimum withdrawal', 'withdraw_min'], ['my withdrawal was rejected', 'rejected'], ['how do I add my UPI id', 'paydetails'], ['bank account ifsc kaha bharna hai', 'paydetails'],
  ['what does available balance mean', 'balance'], ['how does the streak work', 'streak'], ['is there a streak bonus', 'streak_bonus'], ['where did my old logs go', 'logs_delete'], ['how can I request my old call logs', 'logs_request'],
  ['what is a callback', 'callback'], ['where are the terms and conditions', 'terms'], ['what if I have no internet', 'offline'], ['permission denied for call log', 'perm'], ['do you record my calls', 'rec'],
  ['hello', 'greet'], ['I forgot my password', 'login'], ['what happens if I call the same number twice', 'repeat'], ['does a call from the normal dialer count', 'dialer'],
  ['Withdrawl kaise karu?', 'withdraw'], ['WHY IS MY CALL NOT COUNTED???', 'notcounted'], ['streak kya hai', 'streak'],
];
test('about 30 sample questions get the right topic (English, Hinglish, typos, caps)', () => { const bad = CASES.filter(([q, id]) => H(q, LIVE).topic !== id).map(([q, id]) => q + ' => ' + H(q, LIVE).topic + ' (wanted ' + id + ')'); assert.deepEqual(bad, []); assert.ok(CASES.length >= 30); });
const OFF = ['what is the weather today', 'tell me a joke', 'who won the cricket match', 'write a poem about love', 'what is the capital of France', 'call my mom', 'how do I cook biryani', 'bitcoin price today', 'translate this to French', 'who is the prime minister', 'can I get a loan', 'you are stupid', '', '   ', '???'];
test('anything else: "I can only help with using this app", never invents policy', () => { for (const q of OFF) { const r = H(q, LIVE); assert.equal(r.matched, false, q); assert.match(r.answer, /^I can only help with using this app/); assert.ok(r.suggestions.length >= 3); } });
test('answers use the LIVE rules from settings', () => {
  assert.match(H('how are my calls counted', LIVE).answer, /at least 45 seconds/); assert.match(H('how are my calls counted', LIVE).answer, /12 hours/); assert.match(H('how are my calls counted', LIVE).answer, /₹3 per counted call and ₹30/);
  assert.match(H('minimum withdrawal', LIVE).answer, /₹250/); assert.match(H('how to withdraw', LIVE).answer, /16 hours/); assert.match(H('how does the streak work', LIVE).answer, /at least 15 counted calls/);
  assert.match(H('streak bonus', LIVE).answer, /₹100 when your streak reaches 7 days/); assert.match(H('streak bonus', LIVE).answer, /₹500 at 30 days/); assert.match(H('streak bonus', { ...LIVE, streak_bonus_7: 0, streak_bonus_30: 0 }).answer, /no streak bonus/);
  assert.match(H('why are my logs gone', LIVE).answer, /10 days/); assert.match(H('callback', LIVE).answer, /not paid/); assert.match(H('callback', { ...LIVE, callback_counts: 1 }).answer, /earn the per-call rate/);
});
test('Help never claims to be an AI and never promises what the app does not do', () => {
  const all = ['counting', 'withdraw', 'rec', 'callback'].map(q => H(q === 'rec' ? 'do you record calls' : q === 'counting' ? 'how are calls counted' : q, LIVE).answer).join(' ');
  assert.ok(!/\bAI\b|artificial|chatgpt|openai/i.test(all)); assert.match(H('do you record my calls', LIVE).answer, /not recorded/); assert.match(H('how to withdraw', LIVE).answer, /does not move money/);
});
