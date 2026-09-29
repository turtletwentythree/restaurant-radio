// Supabase Edge Function: music-api
//
// Single-shop cloud backend for the restaurant radio player.
// One row in `shop_data` holds a shared passphrase hash + the app's whole
// state (playlists, track metadata, settings) as JSON. Audio files live in
// the private `songs` Storage bucket. Any device that knows the shop
// passphrase can read/write the same playlist library and play the same
// songs — that's what fixed "songs don't show up on a different phone".
//
// Deploy with the Supabase MCP tool `deploy_edge_function`, or the
// Supabase CLI: `supabase functions deploy music-api`.
// Requires: `songs` storage bucket (private) + `shop_data` table (see
// supabase/schema.sql). No custom secrets needed — SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are auto-injected by the platform.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const BUCKET = 'songs';

const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function defaultState() {
  const p1 = 'pl_general', p2 = 'pl_songkran', p3 = 'pl_loikrathong', p4 = 'pl_christmas', p5 = 'pl_newyear',
    p6 = 'pl_valentine', p7 = 'pl_halloween', p8 = 'pl_mothersday';
  return {
    shopName: 'ร้านของฉัน',
    playlists: [
      { id: p1, name: 'เพลงทั่วไป' }, { id: p2, name: 'สงกรานต์' }, { id: p3, name: 'ลอยกระทง' },
      { id: p4, name: 'คริสต์มาส' }, { id: p5, name: 'ปีใหม่' }, { id: p6, name: 'วาเลนไทน์' },
      { id: p7, name: 'ฮาโลวีน' }, { id: p8, name: 'วันแม่' },
    ],
    tracks: [],
    settings: { shuffle: false, repeat: 'off', volume: 0.9, activePlaylistId: p1 },
  };
}

// Loads (and lazily creates) the single shop row, checking/claiming the passphrase.
async function authRow(passphrase: string) {
  if (!passphrase || typeof passphrase !== 'string' || passphrase.length < 4) {
    return { ok: false, status: 400, error: 'ต้องระบุรหัสผ่านร้าน (อย่างน้อย 4 ตัวอักษร)' };
  }
  const hash = await sha256(passphrase);
  const { data: existing, error: selErr } = await admin
    .from('shop_data')
    .select('*')
    .eq('key', 'main')
    .maybeSingle();
  if (selErr) return { ok: false, status: 500, error: selErr.message };

  if (!existing) {
    // First ever call claims the passphrase for this shop.
    const { data: created, error: insErr } = await admin
      .from('shop_data')
      .insert({ key: 'main', passphrase_hash: hash, state: defaultState() })
      .select('*')
      .single();
    if (insErr) return { ok: false, status: 500, error: insErr.message };
    return { ok: true, row: created };
  }

  if (!existing.passphrase_hash) {
    const { data: updated, error: upErr } = await admin
      .from('shop_data')
      .update({ passphrase_hash: hash })
      .eq('key', 'main')
      .select('*')
      .single();
    if (upErr) return { ok: false, status: 500, error: upErr.message };
    return { ok: true, row: updated };
  }

  if (existing.passphrase_hash !== hash) {
    return { ok: false, status: 401, error: 'รหัสผ่านไม่ถูกต้อง' };
  }
  return { ok: true, row: existing };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });

  const url = new URL(req.url);
  const action = url.searchParams.get('action') || '';

  try {
    if (action === 'bootstrap') {
      const passphrase = url.searchParams.get('passphrase') || '';
      const auth = await authRow(passphrase);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      return json({ state: auth.row.state });
    }

    if (action === 'save-state') {
      const body = await req.json();
      const auth = await authRow(body.passphrase);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      const { error } = await admin
        .from('shop_data')
        .update({ state: body.state, updated_at: new Date().toISOString() })
        .eq('key', 'main');
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'change-passphrase') {
      const body = await req.json();
      const auth = await authRow(body.passphrase);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      if (!body.newPassphrase || body.newPassphrase.length < 4) {
        return json({ error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 4 ตัวอักษร' }, 400);
      }
      const newHash = await sha256(body.newPassphrase);
      const { error } = await admin.from('shop_data').update({ passphrase_hash: newHash }).eq('key', 'main');
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    if (action === 'upload') {
      const form = await req.formData();
      const passphrase = String(form.get('passphrase') || '');
      const trackId = String(form.get('trackId') || '');
      const file = form.get('file');
      const auth = await authRow(passphrase);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      if (!trackId || !(file instanceof File)) return json({ error: 'ข้อมูลไม่ครบ' }, 400);
      const path = `${trackId}`;
      const { error } = await admin.storage.from(BUCKET).upload(path, file, {
        contentType: file.type || 'audio/mpeg',
        upsert: true,
      });
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, path });
    }

    if (action === 'play') {
      const passphrase = url.searchParams.get('passphrase') || '';
      const trackId = url.searchParams.get('trackId') || '';
      const auth = await authRow(passphrase);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      if (!trackId) return json({ error: 'ต้องระบุ trackId' }, 400);
      const { data, error } = await admin.storage.from(BUCKET).createSignedUrl(trackId, 3600);
      if (error) return json({ error: error.message }, 500);
      return json({ url: data.signedUrl });
    }

    if (action === 'delete-track') {
      const body = await req.json();
      const auth = await authRow(body.passphrase);
      if (!auth.ok) return json({ error: auth.error }, auth.status);
      if (!body.trackId) return json({ error: 'ต้องระบุ trackId' }, 400);
      await admin.storage.from(BUCKET).remove([body.trackId]);
      return json({ ok: true });
    }

    return json({ error: 'ไม่รู้จัก action นี้' }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || 'unknown error' }, 500);
  }
});
