const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ---------- config ----------
const PORT = process.env.PORT || 3000;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || 'bob15admin';
const MIN_BOOKING_DATE = process.env.MIN_BOOKING_DATE || '2026-08-31';
const BOOKING_HORIZON_WEEKS = 2;
const BOOKING_HORIZON_DAYS = BOOKING_HORIZON_WEEKS * 7;
const WEEKLY_LIMIT_PER_TEAM = 5;
const BAN_TRIGGER_COUNT = 3;
const BAN_DAYS_AFTER_CANCEL = 14;

const ROOMS = ['5E', '5D'];
const SLOTS = [
  { start: '09:00', end: '11:00', label: '09-11' },
  { start: '11:00', end: '13:00', label: '11-13' },
  { start: '13:00', end: '15:00', label: '13-15' },
  { start: '15:00', end: '17:00', label: '15-17' },
  { start: '17:00', end: '19:00', label: '17-19' },
  { start: '19:00', end: '21:00', label: '19-21' },
];

// ---------- storage (JSON file — mount a Railway volume at DATA_DIR for persistence) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

function ensureDb() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ reservations: [], cancellations: [], blockedDates: [] }, null, 2));
  }
}
function readDb() {
  ensureDb();
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
  // 기존에 배포된 db.json에는 blockedDates가 없을 수 있으므로 없으면 채워준다
  if (!Array.isArray(db.blockedDates)) db.blockedDates = [];
  return db;
}
function writeDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// simple write queue to avoid lost updates under concurrent requests
let writeChain = Promise.resolve();
function withDb(mutator) {
  writeChain = writeChain.then(() => {
    const db = readDb();
    const result = mutator(db);
    writeDb(db);
    return result;
  });
  return writeChain;
}

// ---------- date helpers ----------
// Railway 서버는 보통 UTC로 도는데, 예약 시스템은 한국(KST, UTC+9) 기준으로 "오늘"을 판단해야 함.
// new Date(dateStr + 'T00:00:00')로 파싱한 뒤 toISOString()으로 되돌리면 서버 타임존에 따라
// 하루씩 밀리는 버그가 생기므로, 모든 날짜 연산은 UTC로 명시적으로 고정해서 처리한다.

function todayStr() {
  const now = new Date();
  const kstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000); // UTC -> KST 보정
  return kstNow.toISOString().slice(0, 10);
}

function addDaysToDateStr(dateStr, delta) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function bookingHorizonEndStr() {
  return addDaysToDateStr(todayStr(), BOOKING_HORIZON_DAYS);
}
function bookingFloorStr() {
  const today = todayStr();
  return today > MIN_BOOKING_DATE ? today : MIN_BOOKING_DATE;
}
function isWithinBookingHorizon(dateStr) {
  return dateStr >= bookingFloorStr() && dateStr <= bookingHorizonEndStr();
}
function isSameDay(dateStr) {
  return dateStr === todayStr();
}
function getWeekStartStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diffToMonday);
  return dt.toISOString().slice(0, 10);
}

// ---------- business rules ----------
// 팀명 비교는 앞뒤 공백·대소문자·중간 공백 차이를 모두 무시하고 같은 팀으로 인식한다
// (예: "비오비 화이팅", "비오비화이팅", "  비오비  화이팅 " 모두 동일 팀으로 취급)
function normalizeTeamName(team) {
  return String(team || '').trim().toLowerCase().replace(/\s+/g, '');
}

// PM 연락처 비교는 하이픈·공백 등 구분자 차이를 무시하고 숫자만 비교한다
function normalizePhone(contact) {
  return String(contact || '').replace(/[^0-9]/g, '');
}

// 같은 팀이 이미 등록해둔 PM 연락처를 찾는다 (있으면 이후 예약은 그 번호와 일치해야 함)
function findTeamRegisteredContact(reservations, team, excludeId) {
  const normalized = normalizeTeamName(team);
  const match = reservations.find(
    (r) => r.id !== excludeId && r.contact && normalizeTeamName(r.team) === normalized
  );
  return match ? match.contact : null;
}

function countTeamReservationsInWeek(reservations, team, dateStr) {
  const weekStart = getWeekStartStr(dateStr);
  const normalized = normalizeTeamName(team);
  return reservations.filter(
    (r) => r.team && normalizeTeamName(r.team) === normalized && getWeekStartStr(r.date) === weekStart
  ).length;
}

function getTeamBanInfo(cancellations, team) {
  const normalized = normalizeTeamName(team);
  const events = cancellations
    .filter((c) => c.team && normalizeTeamName(c.team) === normalized)
    .sort((a, b) => new Date(a.cancelledAt) - new Date(b.cancelledAt));

  if (events.length < BAN_TRIGGER_COUNT) return { banned: false };

  const mostRecent = events[events.length - 1];
  const banEnd = new Date(new Date(mostRecent.cancelledAt).getTime() + BAN_DAYS_AFTER_CANCEL * 24 * 60 * 60 * 1000);
  return banEnd.getTime() > Date.now() ? { banned: true, until: banEnd.toISOString().slice(0, 10) } : { banned: false };
}

function findReservation(reservations, date, room, slotIndex) {
  return reservations.find((r) => r.date === date && r.room === room && r.slotIndex === slotIndex);
}

// ---------- routes ----------

// list all reservations (board + calendar + client-side rendering use this)
function sanitizeForPublic(reservation) {
  // pin과 연락처는 조회 응답에 포함하지 않음 — 비밀번호가 그대로 노출되면
  // 취소·수정 보호 기능이 무의미해지고, 연락처도 공개 게시판에 노출하지 않기로 함
  const { pin, contact, ...rest } = reservation;
  return rest;
}

app.get('/api/reservations', (req, res) => {
  const db = readDb();
  res.json({
    reservations: db.reservations.map(sanitizeForPublic),
    meta: {
      rooms: ROOMS,
      slots: SLOTS,
      bookingFloor: bookingFloorStr(),
      bookingHorizonEnd: bookingHorizonEndStr(),
      today: todayStr(),
      blockedDates: db.blockedDates,
    },
  });
});

// create a reservation
app.post('/api/reservations', async (req, res) => {
  const { date, room, slotIndex, name, team, contact, pin } = req.body || {};

  if (!date || !ROOMS.includes(room) || !Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= SLOTS.length) {
    return res.status(400).json({ error: '요청 형식이 올바르지 않아요.' });
  }
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: '사용자 이름을 입력해주세요.' });
  }
  if (!contact || !String(contact).trim()) {
    return res.status(400).json({ error: 'PM 연락처를 입력해주세요.' });
  }
  if (!/^\d{4}$/.test(pin || '')) {
    return res.status(400).json({ error: '비밀번호 4자리를 숫자로 입력해주세요.' });
  }
  if (!isWithinBookingHorizon(date)) {
    return res.status(400).json({
      error: `예약은 ${bookingFloorStr()}부터 ${bookingHorizonEndStr()}까지만 가능해요.`,
    });
  }

  try {
    const result = await withDb((db) => {
      if (findReservation(db.reservations, date, room, slotIndex)) {
        return { error: '이미 예약된 시간이에요. 새로고침 후 다시 시도해주세요.', status: 409 };
      }
      if (db.blockedDates.includes(date)) {
        return { error: '운영진이 예약을 막아둔 날짜예요. 다른 날짜를 선택해주세요.', status: 403 };
      }

      const trimmedTeam = team ? String(team).trim() : '';
      const trimmedContact = String(contact).trim();

      if (trimmedTeam) {
        const banInfo = getTeamBanInfo(db.cancellations, trimmedTeam);
        if (banInfo.banned) {
          return {
            error: `'${trimmedTeam}' 팀은 예약 취소·노쇼 누적 ${BAN_TRIGGER_COUNT}회로 ${banInfo.until}까지 예약이 제한돼요.`,
            status: 403,
          };
        }
        const weeklyCount = countTeamReservationsInWeek(db.reservations, trimmedTeam, date);
        if (weeklyCount >= WEEKLY_LIMIT_PER_TEAM) {
          return {
            error: `'${trimmedTeam}' 팀은 이번 주에 이미 ${WEEKLY_LIMIT_PER_TEAM}타임을 예약했어요. 다음 주에 다시 예약해주세요.`,
            status: 403,
          };
        }

        // PM 연락처는 팀마다 고정이어야 하므로, 그 팀이 이전에 등록한 연락처와 일치하는지 이중 확인한다
        const registeredContact = findTeamRegisteredContact(db.reservations, trimmedTeam, null);
        if (registeredContact && normalizePhone(registeredContact) !== normalizePhone(trimmedContact)) {
          return {
            error: `'${trimmedTeam}' 팀에 등록된 PM 연락처와 일치하지 않아요. 이전에 입력한 연락처를 다시 확인해주세요.`,
            status: 400,
          };
        }
      }

      const reservation = {
        id: crypto.randomUUID(),
        date,
        room,
        slotIndex,
        name: String(name).trim(),
        team: trimmedTeam,
        contact: trimmedContact,
        pin: String(pin),
        createdAt: new Date().toISOString(),
      };
      db.reservations.push(reservation);
      return { reservation, status: 201 };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json({ reservation: result.reservation });
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했어요. 다시 시도해주세요.' });
  }
});

// edit a reservation (requires correct pin)
app.put('/api/reservations/:id', async (req, res) => {
  const { id } = req.params;
  const { name, team, contact, pin } = req.body || {};

  if (!contact || !String(contact).trim()) {
    return res.status(400).json({ error: 'PM 연락처를 입력해주세요.' });
  }

  try {
    const result = await withDb((db) => {
      const target = db.reservations.find((r) => r.id === id);
      if (!target) return { error: '이미 삭제된 예약이에요.', status: 404 };
      if (pin !== target.pin) return { error: '비밀번호가 일치하지 않아요.', status: 403 };

      const trimmedTeam = team ? String(team).trim() : '';
      const trimmedContact = String(contact).trim();

      if (trimmedTeam) {
        const registeredContact = findTeamRegisteredContact(db.reservations, trimmedTeam, id);
        if (registeredContact && normalizePhone(registeredContact) !== normalizePhone(trimmedContact)) {
          return {
            error: `'${trimmedTeam}' 팀에 등록된 PM 연락처와 일치하지 않아요. 이전에 입력한 연락처를 다시 확인해주세요.`,
            status: 400,
          };
        }
      }

      if (name && String(name).trim()) target.name = String(name).trim();
      target.team = trimmedTeam;
      target.contact = trimmedContact;
      return { reservation: target };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ reservation: result.reservation });
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했어요. 다시 시도해주세요.' });
  }
});

// cancel a reservation (requires correct pin, blocked same-day)
app.delete('/api/reservations/:id', async (req, res) => {
  const { id } = req.params;
  const { pin } = req.body || {};

  try {
    const result = await withDb((db) => {
      const target = db.reservations.find((r) => r.id === id);
      if (!target) return { error: '이미 삭제된 예약이에요.', status: 404 };

      if (isSameDay(target.date)) {
        return {
          error: '당일 취소는 불가능해요. 이용이 어려운 경우 운영진에게 알려주세요.',
          status: 403,
        };
      }
      if (pin !== target.pin) return { error: '비밀번호가 일치하지 않아요.', status: 403 };

      db.reservations = db.reservations.filter((r) => r.id !== id);
      if (target.team) {
        db.cancellations.push({
          team: target.team,
          date: target.date,
          cancelledAt: new Date().toISOString(),
          type: 'cancel',
        });
      }
      return { ok: true };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했어요. 다시 시도해주세요.' });
  }
});

// mark a reservation as a no-show (staff action — gated by admin passcode)
app.post('/api/reservations/:id/noshow', async (req, res) => {
  const { id } = req.params;
  const { adminPasscode } = req.body || {};

  if (adminPasscode !== ADMIN_PASSCODE) {
    return res.status(401).json({ error: '운영진 비밀번호가 일치하지 않아요.' });
  }

  try {
    const result = await withDb((db) => {
      const target = db.reservations.find((r) => r.id === id);
      if (!target) return { error: '이미 삭제된 예약이에요.', status: 404 };

      db.reservations = db.reservations.filter((r) => r.id !== id);
      if (target.team) {
        db.cancellations.push({
          team: target.team,
          date: target.date,
          cancelledAt: new Date().toISOString(),
          type: 'noshow',
        });
      }
      return { ok: true };
    });

    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했어요. 다시 시도해주세요.' });
  }
});

// admin-only CSV export
app.post('/api/export.csv', (req, res) => {
  const { adminPasscode } = req.body || {};
  if (adminPasscode !== ADMIN_PASSCODE) {
    return res.status(401).json({ error: '운영진 비밀번호가 일치하지 않아요.' });
  }

  const db = readDb();
  const sorted = [...db.reservations].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.slotIndex !== b.slotIndex) return a.slotIndex - b.slotIndex;
    return a.room < b.room ? -1 : 1;
  });

  const dowLabels = ['일', '월', '화', '수', '목', '금', '토'];
  const header = ['날짜', '요일', '시간', '강의실', '프로젝트팀명', '사용자', '연락처', '예약등록시각'];
  const rows = sorted.map((r) => {
    const slot = SLOTS[r.slotIndex];
    const [dy, dm, dd] = r.date.split('-').map(Number);
    const dow = dowLabels[new Date(Date.UTC(dy, dm - 1, dd)).getUTCDay()] + '요일';
    return [
      r.date,
      dow,
      `${slot.start}-${slot.end}`,
      r.room,
      r.team || '',
      r.name || '',
      r.contact || '',
      r.createdAt ? new Date(r.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '',
    ];
  });

  const csvEscape = (val) => {
    const str = String(val ?? '');
    return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const csvContent = [header, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  const stamp = todayStr();

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="BoB15기_강의실예약현황_${stamp}.csv"`);
  res.send('\uFEFF' + csvContent);
});

// ---------- admin routes (모두 운영진 비밀번호 필요) ----------

function checkAdmin(req, res) {
  const passcode = req.body?.adminPasscode || req.query?.adminPasscode;
  if (passcode !== ADMIN_PASSCODE) {
    res.status(401).json({ error: '운영진 비밀번호가 일치하지 않아요.' });
    return false;
  }
  return true;
}

// 운영진 로그인 확인용 (관리자 화면 진입 시 비밀번호 검증만 하는 용도)
app.post('/api/admin/login', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json({ ok: true });
});

// 관리자용: 연락처 포함 전체 예약 목록
app.post('/api/admin/reservations', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const db = readDb();
  const sorted = [...db.reservations].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.slotIndex !== b.slotIndex) return a.slotIndex - b.slotIndex;
    return a.room < b.room ? -1 : 1;
  });
  res.json({
    reservations: sorted.map(({ pin, ...rest }) => rest), // pin은 관리자 화면에도 노출하지 않음
    meta: { rooms: ROOMS, slots: SLOTS, today: todayStr(), blockedDates: db.blockedDates },
  });
});

// 관리자용: 예약 강제 삭제 (취소·노쇼 이력을 남기지 않는 단순 정정용 — 실수로 잘못 들어간 예약 정리 등)
app.post('/api/admin/reservations/:id/delete', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { id } = req.params;
  try {
    const result = await withDb((db) => {
      const before = db.reservations.length;
      db.reservations = db.reservations.filter((r) => r.id !== id);
      if (db.reservations.length === before) return { error: '이미 삭제된 예약이에요.', status: 404 };
      return { ok: true };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했어요. 다시 시도해주세요.' });
  }
});

// 예약 불가 날짜 목록 조회 (공개 — 예약판에서 흐리게 표시하기 위해 필요)
app.get('/api/blocked-dates', (req, res) => {
  const db = readDb();
  res.json({ blockedDates: db.blockedDates });
});

// 관리자용: 예약 불가 날짜 추가/해제
app.post('/api/admin/blocked-dates', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { date, action } = req.body || {};
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않아요 (YYYY-MM-DD).' });
  }
  if (!['add', 'remove'].includes(action)) {
    return res.status(400).json({ error: 'action은 add 또는 remove여야 해요.' });
  }

  try {
    const result = await withDb((db) => {
      if (action === 'add') {
        if (!db.blockedDates.includes(date)) db.blockedDates.push(date);
        db.blockedDates.sort();
      } else {
        db.blockedDates = db.blockedDates.filter((d) => d !== date);
      }
      return { blockedDates: db.blockedDates };
    });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: '서버 오류가 발생했어요. 다시 시도해주세요.' });
  }
});

// health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// HTML 페이지는 항상 최신 버전을 받도록 캐시를 막는다
// (브라우저가 옛날 라우팅 결과를 캐싱해서 새 페이지가 안 보이는 문제를 방지)
function noCache(req, res, next) {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
}

// static frontend
app.use(express.static(path.join(__dirname, 'public'), { etag: false, lastModified: false }));
app.get('/admin', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('*', noCache, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

ensureDb();
app.listen(PORT, () => {
  console.log(`BoB 15기 강의실 예약 서버 실행 중: http://localhost:${PORT}`);
});
