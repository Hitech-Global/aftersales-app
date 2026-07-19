-- Migration: 20260718_remove_default_admin_password.sql
-- Purpose: Neutralise the legacy weak default credentials (admin/admin, operator/operator,
--          viewer/viewer) that were seeded on first run.
-- Scope:   Surgical. Only clears the KNOWN weak defaults; never disables the account
--          (user_admin row is preserved because break-glass maps to it by id).
-- Note:    With AUTH-SECURITY-FIX-01-L1, login is via Feishu OAuth or break-glass
--          (which verifies an env-supplied hash and ignores the DB password), so the
--          DB password field is no longer used for authentication. Clearing it removes
--          the standing default-credential risk without affecting break-glass.

-- 仅清理已知的弱默认口令；保留账号本身（status 不变）
UPDATE users
SET password = ''
WHERE password IN ('admin', 'operator', 'viewer')
  AND id IN ('user_admin', 'user_operator', 'user_viewer');
