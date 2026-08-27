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
    fs.writeFileSync(DB_FILE, JSON.stringify({ reservations: [], cancellations: [] }, null, 2));
  }
}
function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
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
function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
function bookingHorizonEndStr() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + BOOKING_HORIZON_DAYS);
  return d.toISOString().slice(0, 10);
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
  const d = new Date(`${dateStr}T00:00:00`);
  const dow = d.getDay();
  const diffToMonday = dow === 0 ? -6 : 1 - dow;
  d.setDate(d.getDate() + diffToMonday);
  return d.toISOString().slice(0, 10);
}

// ---------- business rules ----------
function countTeamReservationsInWeek(reservations, team, dateStr) {
  const weekStart = getWeekStartStr(dateStr);
  const normalized = team.trim().toLowerCase();
  return reservations.filter(
    (r) => r.team && r.team.trim().toLowerCase() === normalized && getWeekStartStr(r.date) === weekStart
  ).length;
}

function getTeamBanInfo(cancellations, team) {
  const normalized = team.trim().toLowerCase();
  const events = cancellations
    .filter((c) => c.team && c.team.trim().toLowerCase() === normalized)
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
app.get('/api/reservations', (req, res) => {
  const db = readDb();
  res.json({
    reservations: db.reservations,
    meta: {
      rooms: ROOMS,
      slots: SLOTS,
      bookingFloor: bookingFloorStr(),
      bookingHorizonEnd: bookingHorizonEndStr(),
      today: todayStr(),
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

      const trimmedTeam = team ? String(team).trim() : '';
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
      }

      const reservation = {
        id: crypto.randomUUID(),
        date,
        room,
        slotIndex,
        name: String(name).trim(),
        team: trimmedTeam,
        contact: contact ? String(contact).trim() : '',
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

  try {
    const result = await withDb((db) => {
      const target = db.reservations.find((r) => r.id === id);
      if (!target) return { error: '이미 삭제된 예약이에요.', status: 404 };
      if (pin !== target.pin) return { error: '비밀번호가 일치하지 않아요.', status: 403 };

      if (name && String(name).trim()) target.name = String(name).trim();
      target.team = team ? String(team).trim() : '';
      target.contact = contact ? String(contact).trim() : '';
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
    const dow = dowLabels[new Date(`${r.date}T00:00:00`).getDay()] + '요일';
    return [
      r.date,
      dow,
      `${slot.start}-${slot.end}`,
      r.room,
      r.team || '',
      r.name || '',
      r.contact || '',
      r.createdAt ? new Date(r.createdAt).toLocaleString('ko-KR') : '',
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

// health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

ensureDb();
app.listen(PORT, () => {
  console.log(`BoB 15기 강의실 예약 서버 실행 중: http://localhost:${PORT}`);
});
