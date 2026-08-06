'use strict';
const express = require('express');
const db = require('./../db');
const { requireAuth, requireRole } = require('./../auth/middleware');
const passService = require('./../services/passService');
const mailer = require('./../services/mailer');
const { buildPassPdf } = require('./../services/passPdf');

const router = express.Router();
router.use(requireAuth, requireRole('security', 'management'));

// List requests, newest first. ?status=pending|approved|denied (default pending).
router.get('/', async (req, res) => {
  const status = ['pending', 'approved', 'denied'].includes(req.query.status)
    ? req.query.status : 'pending';
  const r = await db.query(
    `SELECT pr.id, pr.status, pr.created_at, pr.requester_name, pr.requester_contact,
            pr.visitor_first_name, pr.visitor_last_name, pr.visitor_plate, pr.visitor_region,
            pr.duration_preset, pr.starts_at, pr.note, pr.pass_id, pr.decided_at, pr.decision_note,
            u.unit_number, u.kind, usr.full_name AS decided_by_name
       FROM pass_requests pr
       JOIN units u ON u.id = pr.unit_id
       LEFT JOIN users usr ON usr.id = pr.decided_by
      WHERE pr.status = $1
      ORDER BY pr.created_at ASC
      LIMIT 200`,
    [status]
  );
  res.json(r.rows);
});

// Approve a pending request -> issue a real pass (quota enforced here). The
// override path reuses the weekly-code mechanism.
router.post('/:id/approve', async (req, res) => {
  const { override, overrideCode, overrideReason, spotOverride } = req.body || {};
  const reqRow = await db.query(
    `SELECT pr.*, u.unit_number FROM pass_requests pr
       JOIN units u ON u.id = pr.unit_id
      WHERE pr.id = $1`,
    [req.params.id]
  );
  if (reqRow.rowCount === 0) return res.status(404).json({ error: 'request_not_found' });
  const pr = reqRow.rows[0];
  if (pr.status !== 'pending') return res.status(409).json({ error: 'already_decided', status: pr.status });

  // Split stored 'CA-ON' back into country + region for issuance.
  let country, region;
  if (pr.visitor_region && pr.visitor_region.includes('-')) {
    [country, region] = pr.visitor_region.split('-');
  }

  try {
    const result = await passService.issuePass({
      unitNumber: pr.unit_number,
      visitorPlate: pr.visitor_plate,
      visitorFirstName: pr.visitor_first_name,
      visitorLastName: pr.visitor_last_name,
      visitorCountry: country,
      visitorRegion: region,
      durationPreset: pr.duration_preset,
      startsAt: pr.starts_at || undefined,
      issuer: req.user,
      override: Boolean(override),
      overrideCode,
      overrideReason,
      spotOverride: Boolean(spotOverride),
    });
    await db.query(
      `UPDATE pass_requests
          SET status = 'approved', pass_id = $1, decided_by = $2, decided_at = now()
        WHERE id = $3`,
      [result.pass.id, req.user.id, pr.id]
    );

    // Email the resident their pass (with a printable PDF) if we have an address.
    let emailed = false;
    if (pr.requester_email) {
      try {
        const pdf = await buildPassPdf({
          pass: result.pass, token: result.token, shortCode: result.shortCode,
          issuerName: req.user.name, issuerRole: req.user.role,
        });
        const when = new Date(result.pass.expires_at).toLocaleString();
        const outcome = await mailer.sendMail({
          to: pr.requester_email,
          subject: `Your visitor parking pass — Unit ${pr.unit_number} (ref ${pr.ref_code})`,
          text: `Your visitor parking pass request (reference ${pr.ref_code}) has been approved.\n\n`
              + `Unit: ${pr.unit_number}\nVisitor plate: ${result.pass.visitor_plate}\n`
              + `Valid until: ${when}\nVerification code: ${result.shortCode}\n\n`
              + `The printable pass is attached. Display it on the vehicle dashboard with the plate visible.`,
          attachments: [{ filename: `parking-pass-${pr.ref_code}.pdf`, content: pdf }],
        });
        emailed = outcome.sent;
      } catch (e) { /* email failure must not fail the approval */ }
    }

    res.status(201).json({
      ok: true,
      passId: result.pass.id,
      shortCode: result.shortCode,
      printUrl: `/api/passes/${result.pass.id}/print`,
      usedOverride: result.usedOverride,
      emailed,
      emailConfigured: mailer.isConfigured(),
    });
  } catch (err) {
    const codeMap = {
      unit_not_found: 404, quota_exceeded: 409, spot_full: 409, no_tags_available: 409,
      unit_already_has_active_pass: 409, day_duplicate: 409, override_code_invalid: 403,
      override_reason_required: 400, invalid_plate: 400, invalid_region: 400,
      invalid_start: 400, invalid_duration: 400,
    };
    if (codeMap[err.code]) {
      return res.status(codeMap[err.code]).json({ error: err.code, message: err.message, quota: err.quota, spots: err.spots });
    }
    throw err;
  }
});

// Deny a pending request with an optional note.
router.post('/:id/deny', async (req, res) => {
  const { note } = req.body || {};
  const r = await db.query(
    `UPDATE pass_requests
        SET status = 'denied', decided_by = $1, decided_at = now(), decision_note = $2
      WHERE id = $3 AND status = 'pending'
      RETURNING id`,
    [req.user.id, (note || '').trim() || null, req.params.id]
  );
  if (r.rowCount === 0) return res.status(409).json({ error: 'not_pending_or_missing' });
  res.json({ ok: true });
});

// Count of pending requests — used for the nav badge.
router.get('/pending-count', async (req, res) => {
  const r = await db.query(`SELECT COUNT(*)::int AS n FROM pass_requests WHERE status = 'pending'`);
  res.json({ pending: r.rows[0].n });
});

module.exports = router;
