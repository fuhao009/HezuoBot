-- =============================================================================
-- Hezuo 网关 V2 · Bot Studio · 开放市场
-- PostgreSQL 16 全量 schema
--
-- 约定：
--   * 金额一律 BIGINT，上限 9007199254740991（2^53-1），与 Node 安全整数一致。
--   * 时间一律 TIMESTAMPTZ，存储 UTC。
--   * 枚举用 TEXT + CHECK，不用 PG ENUM（加值不需 ALTER TYPE）。
--   * 不可变表：应用角色只有 SELECT/INSERT，触发器再拦 UPDATE/DELETE。
--   * balance 只能由 fn_ai_reserve / fn_ai_settle / fn_ai_release / fn_ai_adjust 写。
--
-- 执行：psql -v ON_ERROR_STOP=1 -f schema.sql
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 0. 常量与角色
-- -----------------------------------------------------------------------------

-- 金额上限。所有金额列的 CHECK 都引用这个值（直接写字面量，PG 不支持在 CHECK 里用变量）。
-- 2^53 - 1 = 9007199254740991

COMMENT ON DATABASE current_database IS 'Hezuo gateway v2';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hezuo_app') THEN
    CREATE ROLE hezuo_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hezuo_readonly') THEN
    CREATE ROLE hezuo_readonly NOLOGIN;
  END IF;
END
$$;

-- -----------------------------------------------------------------------------
-- 1. 配置版本序列：relay 轮询它判断是否需要重载（01 §4.4）
-- -----------------------------------------------------------------------------

CREATE SEQUENCE config_sequence AS BIGINT START 1;

-- -----------------------------------------------------------------------------
-- 2. 上游：provider / channel / channel_key / channel_model
-- -----------------------------------------------------------------------------

CREATE TABLE provider (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL
                  CHECK (kind IN ('openai','anthropic','gemini','openai_compatible','newapi')),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  base_url      TEXT NOT NULL CHECK (base_url ~ '^https://'),
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE channel (
  id            TEXT PRIMARY KEY,
  provider_id   TEXT NOT NULL REFERENCES provider(id),
  base_url      TEXT NOT NULL CHECK (base_url ~ '^https://'),
  -- 一期只对外承诺 chat / responses（D-13）
  protocols     TEXT[] NOT NULL DEFAULT ARRAY['chat']::TEXT[]
                  CHECK (protocols <@ ARRAY['chat','responses']::TEXT[]
                         AND array_length(protocols, 1) >= 1),
  priority      INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0),
  weight        INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 1 AND 10000),
  group_tags    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  revision      INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX channel_provider_idx ON channel(provider_id);
CREATE INDEX channel_enabled_idx ON channel(enabled) WHERE enabled;

CREATE TABLE channel_key (
  id               TEXT PRIMARY KEY,
  channel_id       TEXT NOT NULL REFERENCES channel(id),
  -- enc:v1:<kid>:<base64(iv|ct|tag)>，永不返回给客户端（D-08）
  encrypted_value  TEXT NOT NULL CHECK (encrypted_value ~ '^enc:v1:[0-9]+:'),
  kid              INTEGER NOT NULL CHECK (kid >= 1),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','cooling','exhausted','disabled')),
  -- 手动停用优先于自动恢复（D-10）
  manual_disabled  BOOLEAN NOT NULL DEFAULT FALSE,
  cooldown_until   TIMESTAMPTZ,
  quota_hint       BIGINT CHECK (quota_hint IS NULL OR quota_hint >= 0),
  concurrency_limit INTEGER CHECK (concurrency_limit IS NULL OR concurrency_limit BETWEEN 1 AND 1000),
  revision         INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- manual_disabled 与 status 不能互相矛盾：手动停用的必为 disabled
  CONSTRAINT channel_key_manual_status CHECK (NOT manual_disabled OR status = 'disabled')
);
CREATE INDEX channel_key_channel_idx ON channel_key(channel_id, status);

CREATE TABLE channel_model (
  channel_id      TEXT NOT NULL REFERENCES channel(id),
  upstream_model  TEXT NOT NULL CHECK (length(upstream_model) BETWEEN 1 AND 200),
  public_model_id TEXT NOT NULL,
  -- 成本价：微美元/百万 token，运营者录入的估算（D-18、D-29）
  cost_rates      JSONB NOT NULL CHECK (
                    jsonb_typeof(cost_rates) = 'object'
                    AND cost_rates ? 'input' AND cost_rates ? 'output' AND cost_rates ? 'cached'),
  long_rates      JSONB CHECK (long_rates IS NULL OR jsonb_typeof(long_rates) = 'object'),
  long_threshold  BIGINT CHECK (long_threshold IS NULL OR long_threshold >= 0),
  long_inclusive  BOOLEAN NOT NULL DEFAULT FALSE,
  -- 长上下文相关列必须一起有或一起无
  CONSTRAINT channel_model_long_pair CHECK (
    (long_rates IS NULL AND long_threshold IS NULL)
    OR (long_rates IS NOT NULL AND long_threshold IS NOT NULL)),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, upstream_model)
);
CREATE INDEX channel_model_public_idx ON channel_model(public_model_id);

CREATE TABLE public_model (
  id                 TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  label              TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  protocols          TEXT[] NOT NULL DEFAULT ARRAY['chat']::TEXT[]
                       CHECK (protocols <@ ARRAY['chat','responses']::TEXT[]),
  context_tokens     BIGINT NOT NULL CHECK (context_tokens BETWEEN 1 AND 9007199254740991),
  output_tokens      BIGINT NOT NULL CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  capabilities       JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(capabilities) = 'object'),
  enabled            BOOLEAN NOT NULL DEFAULT FALSE,
  -- 是否可用于考试（D-12 原稿 6.2）
  examinable         BOOLEAN NOT NULL DEFAULT FALSE,
  model_factor_bps   INTEGER NOT NULL DEFAULT 10000 CHECK (model_factor_bps BETWEEN 1 AND 1000000),
  -- 默认渠道；同模型的其他渠道作为额外候选（D-07）
  primary_channel_id TEXT REFERENCES channel(id),
  revision           INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX public_model_enabled_idx ON public_model(enabled) WHERE enabled;

-- -----------------------------------------------------------------------------
-- 3. 路由组
-- -----------------------------------------------------------------------------

CREATE TABLE route_group (
  id                      TEXT PRIMARY KEY CHECK (id ~ '^group/[a-z0-9][a-z0-9-]{0,60}$'),
  label                   TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  strategy                TEXT NOT NULL DEFAULT 'order'
                            CHECK (strategy IN ('order','weighted','rotate','cost','latency','usage','quota')),
  constraints             JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(constraints) = 'object'),
  pricing_mode            TEXT NOT NULL DEFAULT 'passthrough'
                            CHECK (pricing_mode IN ('passthrough','fixed')),
  -- fixed 模式：微积分/请求，成功即扣（D-16）
  fixed_price_micro_points BIGINT CHECK (fixed_price_micro_points IS NULL
                            OR fixed_price_micro_points BETWEEN 0 AND 9007199254740991),
  -- 深度缓存：由应用维护，读取时仍做一次断言（02 §4.4）
  depth                   SMALLINT NOT NULL DEFAULT 1 CHECK (depth BETWEEN 1 AND 3),
  enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
  examinable              BOOLEAN NOT NULL DEFAULT FALSE,
  revision                INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT route_group_fixed_price CHECK (pricing_mode <> 'fixed' OR fixed_price_micro_points IS NOT NULL)
);

CREATE TABLE route_group_member (
  group_id    TEXT NOT NULL REFERENCES route_group(id) ON DELETE CASCADE,
  member_type TEXT NOT NULL CHECK (member_type IN ('model','group')),
  member_id   TEXT NOT NULL,
  weight      INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 1 AND 10000),
  position    INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (group_id, member_type, member_id),
  -- 组成员不能是自身（浅层环，深层环由应用 DFS 校验）
  CONSTRAINT route_group_no_self CHECK (NOT (member_type = 'group' AND member_id = group_id))
);
CREATE UNIQUE INDEX route_group_member_position_idx
  ON route_group_member(group_id, position);
CREATE INDEX route_group_member_member_idx ON route_group_member(member_type, member_id);

-- -----------------------------------------------------------------------------
-- 4. 渠道事件与配置审计（只追加）
-- -----------------------------------------------------------------------------

CREATE TABLE channel_event (
  id          BIGSERIAL PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channel(id),
  key_id      TEXT REFERENCES channel_key(id),
  from_status TEXT CHECK (from_status IN ('active','cooling','exhausted','disabled')),
  to_status   TEXT NOT NULL CHECK (to_status IN ('active','cooling','exhausted','disabled')),
  -- 枚举短码，不含响应正文与密钥（02 §3.2）
  reason      TEXT NOT NULL CHECK (reason ~ '^[a-z0-9_]{1,64}$'),
  status_code INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX channel_event_channel_idx ON channel_event(channel_id, at DESC);

CREATE TABLE config_audit (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      TEXT NOT NULL,
  -- 保存失败（revision 冲突）也记录，作为并发证据（02 §9.2）
  outcome       TEXT NOT NULL DEFAULT 'applied' CHECK (outcome IN ('applied','rejected')),
  object_type   TEXT NOT NULL CHECK (object_type IN
                  ('provider','channel','channel_key','channel_model','public_model',
                   'route_group','user_group','billing_policy','account')),
  object_id     TEXT NOT NULL,
  from_revision INTEGER,
  to_revision   INTEGER,
  -- 已剔除密钥，只保留 hasKey
  before_json   JSONB,
  after_json    JSONB,
  reason        TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  request_id    TEXT,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX config_audit_object_idx ON config_audit(object_type, object_id, at DESC);

-- -----------------------------------------------------------------------------
-- 5. 账户、分组、令牌
-- -----------------------------------------------------------------------------

CREATE TABLE user_group (
  id                TEXT PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,30}$'),
  name              TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  group_factor_bps  INTEGER NOT NULL DEFAULT 10000 CHECK (group_factor_bps BETWEEN 0 AND 100000),
  -- 补贴组允许低于成本下限，需逐组显式开启（D-32）
  allow_below_floor BOOLEAN NOT NULL DEFAULT FALSE,
  -- {concurrency, dailyRequests, dailyMicroPoints}
  limits            JSONB NOT NULL DEFAULT '{}'::JSONB CHECK (jsonb_typeof(limits) = 'object'),
  allowed_models    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO user_group (id, name, group_factor_bps) VALUES ('default', 'Default', 10000)
  ON CONFLICT (id) DO NOTHING;

CREATE TABLE account (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL,
  user_group_id TEXT NOT NULL DEFAULT 'default' REFERENCES user_group(id),
  enabled       BOOLEAN NOT NULL DEFAULT FALSE,
  activated_at  TIMESTAMPTZ,
  -- 账户删除时替换为匿名标识，账本保留（04 §6）
  deleted_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT account_email_unique UNIQUE (email)
);
CREATE INDEX account_group_idx ON account(user_group_id);

-- 模型令牌：只存哈希
CREATE TABLE ai_token (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES account(id),
  device_id     TEXT NOT NULL CHECK (length(device_id) BETWEEN 1 AND 64),
  lookup_id     TEXT NOT NULL UNIQUE CHECK (length(lookup_id) = 22),
  secret_hash   TEXT NOT NULL CHECK (length(secret_hash) = 64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  revoked_at    TIMESTAMPTZ,
  CONSTRAINT ai_token_expiry CHECK (expires_at > created_at)
);
CREATE INDEX ai_token_owner_idx ON ai_token(owner_user_id, revoked_at, expires_at);

-- -----------------------------------------------------------------------------
-- 6. 余额（应用角色只读，只能经函数写）
-- -----------------------------------------------------------------------------

CREATE TABLE balance (
  owner_user_id TEXT PRIMARY KEY REFERENCES account(id),
  available     BIGINT NOT NULL DEFAULT 0
                  CHECK (available BETWEEN 0 AND 9007199254740991),
  reserved      BIGINT NOT NULL DEFAULT 0
                  CHECK (reserved BETWEEN 0 AND 9007199254740991),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 7. 请求与尝试
-- -----------------------------------------------------------------------------

CREATE TABLE ai_request (
  id                      TEXT PRIMARY KEY,
  owner_user_id           TEXT NOT NULL REFERENCES account(id),
  -- 无外键：吊销令牌不能删历史
  token_id                TEXT NOT NULL,
  -- 客户端请求的模型（可能为 group/... 或 auto-chat）
  model                   TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
  selected_model          TEXT NOT NULL CHECK (length(selected_model) BETWEEN 1 AND 128),
  endpoint                TEXT NOT NULL CHECK (endpoint IN ('chat','responses')),
  state                   TEXT NOT NULL DEFAULT 'reserved'
                            CHECK (state IN ('reserved','streaming','review','settled')),
  pricing_version         TEXT NOT NULL CHECK (length(pricing_version) BETWEEN 1 AND 64),

  -- 展示费率快照：微积分 / 百万 token
  input_rate              BIGINT NOT NULL CHECK (input_rate BETWEEN 0 AND 9007199254740991),
  cached_rate             BIGINT NOT NULL CHECK (cached_rate BETWEEN 0 AND 9007199254740991),
  output_rate             BIGINT NOT NULL CHECK (output_rate BETWEEN 0 AND 9007199254740991),

  max_input_tokens        BIGINT NOT NULL CHECK (max_input_tokens BETWEEN 1 AND 9007199254740991),
  max_output_tokens       BIGINT NOT NULL CHECK (max_output_tokens BETWEEN 0 AND 9007199254740991),
  -- 准入冻结额，永不修改
  reserved_micro_points   BIGINT NOT NULL CHECK (reserved_micro_points BETWEEN 0 AND 9007199254740991),
  charged_micro_points    BIGINT CHECK (charged_micro_points IS NULL
                            OR charged_micro_points BETWEEN 0 AND 9007199254740991),

  input_tokens            BIGINT CHECK (input_tokens IS NULL OR input_tokens BETWEEN 0 AND 9007199254740991),
  cached_input_tokens     BIGINT CHECK (cached_input_tokens IS NULL OR cached_input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens           BIGINT CHECK (output_tokens IS NULL OR output_tokens BETWEEN 0 AND 9007199254740991),
  cache_write_tokens      BIGINT CHECK (cache_write_tokens IS NULL OR cache_write_tokens BETWEEN 0 AND 9007199254740991),
  cache_write_hour_tokens BIGINT CHECK (cache_write_hour_tokens IS NULL OR cache_write_hour_tokens BETWEEN 0 AND 9007199254740991),

  -- 缓存分区不得超过输入总量（D-29）
  CONSTRAINT ai_request_cache_partition CHECK (
    input_tokens IS NULL
    OR COALESCE(cached_input_tokens,0) + COALESCE(cache_write_tokens,0)
       + COALESCE(cache_write_hour_tokens,0) <= input_tokens),

  -- 不可变快照（D-26 之外的计价依据）
  billing_snapshot        JSONB NOT NULL CHECK (jsonb_typeof(billing_snapshot) = 'object'),
  -- 合成后的倍率冗余，供聚合查询
  effective_bps           INTEGER NOT NULL CHECK (effective_bps BETWEEN 1 AND 1000000),

  cost_micro_usd          BIGINT CHECK (cost_micro_usd IS NULL OR cost_micro_usd BETWEEN 0 AND 9007199254740991),
  cost_status             TEXT CHECK (cost_status IS NULL
                            OR cost_status IN ('estimated','conservative','unknown')),
  settlement_reason       TEXT CHECK (settlement_reason IS NULL
                            OR length(settlement_reason) BETWEEN 1 AND 200),

  channel_id              TEXT REFERENCES channel(id),
  key_id                  TEXT REFERENCES channel_key(id),
  route_group_id          TEXT REFERENCES route_group(id),

  latency_ms              BIGINT CHECK (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 9007199254740991),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at              TIMESTAMPTZ,

  -- 终态必须有金额与理由
  CONSTRAINT ai_request_settled_amount CHECK (
    state <> 'settled' OR charged_micro_points IS NOT NULL),
  CONSTRAINT ai_request_review_reason CHECK (
    state <> 'review' OR settlement_reason IS NOT NULL)
);

CREATE INDEX ai_request_owner_idx ON ai_request(owner_user_id, created_at DESC, id DESC);
-- 超时扫描：部分索引
CREATE INDEX ai_request_open_idx ON ai_request(created_at)
  WHERE state IN ('reserved','streaming');
CREATE INDEX ai_request_billing_idx ON ai_request(created_at DESC, id DESC)
  WHERE billing_snapshot IS NOT NULL;
CREATE INDEX ai_request_state_idx ON ai_request(state, created_at);

CREATE TABLE request_attempt (
  id             BIGSERIAL PRIMARY KEY,
  request_id     TEXT NOT NULL REFERENCES ai_request(id),
  attempt_no     SMALLINT NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  channel_id     TEXT NOT NULL REFERENCES channel(id),
  key_id         TEXT NOT NULL REFERENCES channel_key(id),
  outcome        TEXT NOT NULL
                   CHECK (outcome IN ('success','partial','retryable_error','fatal_error','abandoned')),
  status_code    INTEGER CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  ttfb_ms        BIGINT CHECK (ttfb_ms IS NULL OR ttfb_ms BETWEEN 0 AND 9007199254740991),
  total_ms       BIGINT CHECK (total_ms IS NULL OR total_ms BETWEEN 0 AND 9007199254740991),
  affinity_broken BOOLEAN NOT NULL DEFAULT FALSE,
  at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT request_attempt_unique UNIQUE (request_id, attempt_no)
);
CREATE INDEX request_attempt_request_idx ON request_attempt(request_id, attempt_no);

-- -----------------------------------------------------------------------------
-- 8. 流水（只追加）与幂等
-- -----------------------------------------------------------------------------

CREATE TABLE ledger_entry (
  id                BIGSERIAL PRIMARY KEY,
  owner_user_id     TEXT NOT NULL REFERENCES account(id),
  kind              TEXT NOT NULL CHECK (kind IN
                      ('grant','expire','reserve','settle','settle_refund',
                       'substitute','enable','disable','adjust')),
  amount_micro_points BIGINT NOT NULL
                      CHECK (amount_micro_points BETWEEN -9007199254740991 AND 9007199254740991),
  request_id        TEXT REFERENCES ai_request(id),
  reason            TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  actor_id          TEXT NOT NULL,
  -- 业务操作标识，同一 kind 内唯一（D-26 幂等）
  op_id             TEXT NOT NULL CHECK (length(op_id) BETWEEN 1 AND 128),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ledger_entry_op_unique UNIQUE (kind, op_id)
);
CREATE INDEX ledger_entry_owner_idx ON ledger_entry(owner_user_id, created_at DESC, id DESC);
CREATE INDEX ledger_entry_request_idx ON ledger_entry(request_id) WHERE request_id IS NOT NULL;

CREATE TABLE ai_idempotency (
  id              BIGSERIAL PRIMARY KEY,
  owner_user_id   TEXT NOT NULL REFERENCES account(id),
  token_id        TEXT NOT NULL,
  endpoint        TEXT NOT NULL CHECK (endpoint IN ('chat','responses')),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,255}$'),
  digest          TEXT NOT NULL CHECK (length(digest) = 64),
  request_id      TEXT NOT NULL REFERENCES ai_request(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_idempotency_unique UNIQUE (owner_user_id, token_id, endpoint, idempotency_key)
);
CREATE INDEX ai_idempotency_expiry_idx ON ai_idempotency(created_at);

CREATE TABLE points_bucket (
  id          BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES account(id),
  kind        TEXT NOT NULL CHECK (kind IN ('grant','purchase')),
  amount      BIGINT NOT NULL CHECK (amount BETWEEN 0 AND 9007199254740991),
  remaining   BIGINT NOT NULL CHECK (remaining BETWEEN 0 AND 9007199254740991),
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT points_bucket_remaining CHECK (remaining <= amount)
);
CREATE INDEX points_bucket_owner_idx ON points_bucket(owner_user_id, expires_at);

CREATE TABLE subsidy_audit (
  id            BIGSERIAL PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES account(id),
  request_id    TEXT NOT NULL REFERENCES ai_request(id),
  floor_bps     INTEGER NOT NULL CHECK (floor_bps >= 1),
  applied_bps   INTEGER NOT NULL CHECK (applied_bps >= 1),
  actor_id      TEXT NOT NULL,
  at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subsidy_audit_below_floor CHECK (applied_bps < floor_bps)
);

-- -----------------------------------------------------------------------------
-- 9. 计费策略（只追加审计）
-- -----------------------------------------------------------------------------

CREATE TABLE billing_policy (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  revision          INTEGER NOT NULL CHECK (revision >= 1),
  policy_json       JSONB NOT NULL CHECK (jsonb_typeof(policy_json) = 'object'),
  multiplier_bps    INTEGER NOT NULL CHECK (multiplier_bps BETWEEN 10000 AND 1000000),
  last_adjusted_at  TIMESTAMPTZ,
  adjustment_reason TEXT NOT NULL,
  actor_id          TEXT NOT NULL,
  reason            TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE billing_policy_audit (
  id             BIGSERIAL PRIMARY KEY,
  revision       INTEGER NOT NULL,
  policy_json    JSONB NOT NULL,
  multiplier_bps INTEGER NOT NULL,
  actor_id       TEXT NOT NULL,
  reason         TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX billing_policy_audit_rev_idx ON billing_policy_audit(revision DESC);

-- -----------------------------------------------------------------------------
-- 10. Bot、版本、题库、考试、市场
-- -----------------------------------------------------------------------------

CREATE TABLE developer (
  account_id  TEXT PRIMARY KEY REFERENCES account(id),
  verified    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE bot (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL REFERENCES account(id),
  slug        TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,60}$'),
  category    TEXT NOT NULL CHECK (category IN ('coding','research','browser','writing','data','customer-service','other')),
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','banned')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX bot_owner_idx ON bot(owner_id);

-- 不可变版本
CREATE TABLE bot_version (
  id              TEXT PRIMARY KEY,
  bot_id          TEXT NOT NULL REFERENCES bot(id),
  semver          TEXT NOT NULL CHECK (semver ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'),
  -- D-34 的精确范围
  bot_hash        TEXT NOT NULL CHECK (length(bot_hash) = 64),
  package_ref     TEXT NOT NULL CHECK (package_ref ~ '^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}$'),
  market_manifest JSONB NOT NULL CHECK (jsonb_typeof(market_manifest) = 'object'),
  lint_report     JSONB NOT NULL DEFAULT '{}'::JSONB,
  review_state    TEXT NOT NULL DEFAULT 'pending'
                    CHECK (review_state IN ('pending','accepted','rejected','manual_review')),
  review_reason   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bot_version_semver_unique UNIQUE (bot_id, semver)
);
CREATE INDEX bot_version_hash_idx ON bot_version(bot_hash);

CREATE TABLE bot_model_claim (
  bot_version_id TEXT NOT NULL REFERENCES bot_version(id),
  model_id       TEXT NOT NULL REFERENCES public_model(id),
  claims         JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(claims) = 'array'),
  PRIMARY KEY (bot_version_id, model_id)
);

CREATE TABLE exam_suite (
  id            TEXT PRIMARY KEY,
  category      TEXT NOT NULL CHECK (category IN ('safety','coding','research','browser','writing','data','customer-service')),
  suite_version INTEGER NOT NULL CHECK (suite_version >= 1),
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exam_suite_version_unique UNIQUE (category, suite_version)
);

CREATE TABLE exam_case (
  id          TEXT PRIMARY KEY,
  suite_id    TEXT NOT NULL REFERENCES exam_suite(id),
  definition  JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  weight      INTEGER NOT NULL DEFAULT 1 CHECK (weight BETWEEN 1 AND 1000),
  difficulty  SMALLINT NOT NULL DEFAULT 3 CHECK (difficulty BETWEEN 1 AND 5),
  visibility  TEXT NOT NULL CHECK (visibility IN ('public','hidden')),
  tags        TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  -- 通过率异常时标记待审
  flagged     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX exam_case_suite_idx ON exam_case(suite_id, visibility) WHERE enabled;

CREATE TABLE rubric_model_allowlist (
  model_id TEXT PRIMARY KEY REFERENCES public_model(id),
  enabled  BOOLEAN NOT NULL DEFAULT TRUE
);

-- 考试估价（D-40）
CREATE TABLE exam_quote (
  id               TEXT PRIMARY KEY,
  bot_version_id   TEXT NOT NULL REFERENCES bot_version(id),
  model_id         TEXT NOT NULL REFERENCES public_model(id),
  requested_by     TEXT NOT NULL REFERENCES account(id),
  estimated_points BIGINT NOT NULL CHECK (estimated_points BETWEEN 0 AND 9007199254740991),
  max_cost_points  BIGINT NOT NULL CHECK (max_cost_points BETWEEN 0 AND 9007199254740991),
  expires_at       TIMESTAMPTZ NOT NULL,
  confirmed_at     TIMESTAMPTZ,
  exam_run_id      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX exam_quote_expiry_idx ON exam_quote(expires_at) WHERE confirmed_at IS NULL;

CREATE TABLE exam_run (
  id                   TEXT PRIMARY KEY,
  quote_id             TEXT NOT NULL UNIQUE REFERENCES exam_quote(id),
  bot_version_id       TEXT NOT NULL REFERENCES bot_version(id),
  model_id             TEXT NOT NULL REFERENCES public_model(id),
  suite_version        INTEGER NOT NULL CHECK (suite_version >= 1),
  -- D-43 身份：bot_hash + model + upstream_fingerprint + suite_version
  bot_hash             TEXT NOT NULL CHECK (length(bot_hash) = 64),
  upstream_fingerprint TEXT NOT NULL CHECK (length(upstream_fingerprint) = 64),
  state                TEXT NOT NULL DEFAULT 'queued'
                         CHECK (state IN ('queued','running','scoring','completed','failed','cancelled','budget_exhausted')),
  -- D-41 预算池
  budget_micro_points  BIGINT NOT NULL CHECK (budget_micro_points BETWEEN 0 AND 9007199254740991),
  budget_used_micro_points BIGINT NOT NULL DEFAULT 0
                         CHECK (budget_used_micro_points BETWEEN 0 AND 9007199254740991),
  total_score          SMALLINT CHECK (total_score IS NULL OR total_score BETWEEN 0 AND 100),
  dimension_scores     JSONB CHECK (dimension_scores IS NULL OR jsonb_typeof(dimension_scores) = 'object'),
  gate_failed          BOOLEAN NOT NULL DEFAULT FALSE,
  gate_reason          TEXT,
  report_ref           TEXT,
  rubric_model_id      TEXT REFERENCES public_model(id),
  seed                 BIGINT NOT NULL DEFAULT 0,
  started_at           TIMESTAMPTZ,
  finished_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exam_run_budget CHECK (budget_used_micro_points <= budget_micro_points),
  CONSTRAINT exam_run_gate CHECK (NOT gate_failed OR gate_reason IS NOT NULL)
);
CREATE INDEX exam_run_state_idx ON exam_run(state, created_at);
CREATE INDEX exam_run_identity_idx ON exam_run(bot_hash, model_id, suite_version);

CREATE TABLE exam_case_result (
  id             BIGSERIAL PRIMARY KEY,
  exam_run_id    TEXT NOT NULL REFERENCES exam_run(id),
  case_id        TEXT NOT NULL REFERENCES exam_case(id),
  variant        TEXT NOT NULL CHECK (length(variant) BETWEEN 1 AND 64),
  run_no         SMALLINT NOT NULL CHECK (run_no BETWEEN 1 AND 10),
  passed         BOOLEAN NOT NULL,
  score          SMALLINT CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  trace_ref      TEXT,
  failure_summary TEXT CHECK (failure_summary IS NULL OR length(failure_summary) <= 500),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT exam_case_result_unique UNIQUE (exam_run_id, case_id, variant, run_no)
);
CREATE INDEX exam_case_result_run_idx ON exam_case_result(exam_run_id);

-- Bot × 模型 的上架状态（D-46 段）
CREATE TABLE listing (
  id             TEXT PRIMARY KEY,
  bot_id         TEXT NOT NULL REFERENCES bot(id),
  model_id       TEXT NOT NULL REFERENCES public_model(id),
  bot_version_id TEXT NOT NULL REFERENCES bot_version(id),
  state          TEXT NOT NULL DEFAULT 'unverified'
                   CHECK (state IN ('unverified','failed','verified','stale','pending_review','delisted')),
  level          TEXT CHECK (level IS NULL OR level IN ('gold','silver','bronze')),
  score          SMALLINT CHECK (score IS NULL OR score BETWEEN 0 AND 100),
  exam_run_id    TEXT REFERENCES exam_run(id),
  valid_until    TIMESTAMPTZ,
  stale_since    TIMESTAMPTZ,
  -- 一期只允许免费（D-13）
  price_per_task_points BIGINT NOT NULL DEFAULT 0 CHECK (price_per_task_points = 0),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT listing_unique UNIQUE (bot_id, model_id),
  CONSTRAINT listing_verified_needs_score CHECK (
    state <> 'verified' OR (score IS NOT NULL AND level IS NOT NULL))
);
CREATE INDEX listing_market_idx ON listing(state, model_id, score DESC NULLS LAST);

CREATE TABLE install (
  id             BIGSERIAL PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES account(id),
  bot_id         TEXT NOT NULL REFERENCES bot(id),
  bot_version_id TEXT NOT NULL REFERENCES bot_version(id),
  model_id       TEXT NOT NULL REFERENCES public_model(id),
  installed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX install_account_idx ON install(account_id, installed_at DESC);

CREATE TABLE feedback (
  id         BIGSERIAL PRIMARY KEY,
  install_id BIGINT NOT NULL REFERENCES install(id),
  rating     SMALLINT NOT NULL CHECK (rating IN (-1, 1)),
  reason     TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE report (
  id          BIGSERIAL PRIMARY KEY,
  listing_id  TEXT REFERENCES listing(id),
  bot_id      TEXT REFERENCES bot(id),
  reporter_id TEXT NOT NULL REFERENCES account(id),
  category    TEXT NOT NULL CHECK (category IN ('safety','quality','other')),
  reason      TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  state       TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','resolved','dismissed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT report_target CHECK (listing_id IS NOT NULL OR bot_id IS NOT NULL)
);
CREATE INDEX report_listing_idx ON report(listing_id, created_at DESC);
CREATE INDEX report_reporter_idx ON report(reporter_id, created_at DESC);

CREATE TABLE moderation_action (
  id          BIGSERIAL PRIMARY KEY,
  object_type TEXT NOT NULL CHECK (object_type IN ('bot','bot_version','listing','author')),
  object_id   TEXT NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('delist','restore','ban','unban','reject','approve','appeal_upheld','appeal_rejected')),
  actor_id    TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX moderation_object_idx ON moderation_action(object_type, object_id, at DESC);

CREATE TABLE exam_audit (
  id          BIGSERIAL PRIMARY KEY,
  exam_run_id TEXT REFERENCES exam_run(id),
  action      TEXT NOT NULL CHECK (action IN ('quote','confirm','start','finish','fail','cancel','rescore','budget_exhausted')),
  actor_id    TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX exam_audit_run_idx ON exam_audit(exam_run_id, at DESC);

-- 每日场次计数（D-45）
CREATE TABLE exam_daily_quota (
  account_id TEXT NOT NULL REFERENCES account(id),
  bot_id     TEXT NOT NULL REFERENCES bot(id),
  model_id   TEXT NOT NULL REFERENCES public_model(id),
  day        DATE NOT NULL,
  runs       SMALLINT NOT NULL DEFAULT 0 CHECK (runs BETWEEN 0 AND 100),
  PRIMARY KEY (account_id, bot_id, model_id, day)
);
CREATE INDEX exam_daily_quota_account_idx ON exam_daily_quota(account_id, day);

-- -----------------------------------------------------------------------------
-- 11. 运维
-- -----------------------------------------------------------------------------

CREATE TABLE outbox (
  id           BIGSERIAL PRIMARY KEY,
  topic        TEXT NOT NULL CHECK (topic ~ '^[a-z0-9_.]{1,64}$'),
  payload      JSONB NOT NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at   TIMESTAMPTZ,
  attempts     SMALLINT NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 20),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox(available_at, id) WHERE claimed_at IS NULL;

CREATE TABLE worker_lease (
  name       TEXT PRIMARY KEY,
  holder     TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reconcile_run (
  id             BIGSERIAL PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('identity','channel_cost')),
  scope          TEXT,
  passed         BOOLEAN NOT NULL,
  detail         JSONB NOT NULL DEFAULT '{}'::JSONB,
  deviation_bps  INTEGER,
  at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX reconcile_run_kind_idx ON reconcile_run(kind, at DESC);

-- =============================================================================
-- 12. 触发器：不可变、状态迁移、配置版本
-- =============================================================================

-- 请求快照不可变
CREATE OR REPLACE FUNCTION fn_reject_snapshot_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.billing_snapshot IS DISTINCT FROM OLD.billing_snapshot THEN
    RAISE EXCEPTION 'ai_request_snapshot_immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.reserved_micro_points IS DISTINCT FROM OLD.reserved_micro_points THEN
    RAISE EXCEPTION 'ai_request_reserved_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_request_immutable_before_update
  BEFORE UPDATE ON ai_request
  FOR EACH ROW EXECUTE FUNCTION fn_reject_snapshot_change();

-- 已结算请求不可再改金额
CREATE OR REPLACE FUNCTION fn_reject_settled_change() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state = 'settled' THEN
    RAISE EXCEPTION 'ai_request_settled_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_request_settled_before_update
  BEFORE UPDATE ON ai_request
  FOR EACH ROW EXECUTE FUNCTION fn_reject_settled_change();

-- 状态机：只允许 04 §2.4 的迁移
CREATE OR REPLACE FUNCTION fn_ai_request_state_transition() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  allowed BOOLEAN;
BEGIN
  IF NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.state
    WHEN 'reserved'  THEN NEW.state IN ('streaming','review','settled')
    WHEN 'streaming' THEN NEW.state IN ('review','settled')
    WHEN 'review'    THEN NEW.state = 'settled'
    ELSE FALSE
  END;

  IF NOT allowed THEN
    RAISE EXCEPTION 'ai_request_illegal_transition: % -> %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.state = 'settled' AND NEW.settled_at IS NULL THEN
    NEW.settled_at := now();
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER ai_request_state_before_update
  BEFORE UPDATE ON ai_request
  FOR EACH ROW EXECUTE FUNCTION fn_ai_request_state_transition();

-- 不可变表：拒绝 UPDATE/DELETE
CREATE OR REPLACE FUNCTION fn_reject_mutation() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table: % on %', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER config_audit_no_update BEFORE UPDATE ON config_audit
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER config_audit_no_delete BEFORE DELETE ON config_audit
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER billing_policy_audit_no_update BEFORE UPDATE ON billing_policy_audit
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER billing_policy_audit_no_delete BEFORE DELETE ON billing_policy_audit
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER moderation_no_update BEFORE UPDATE ON moderation_action
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER moderation_no_delete BEFORE DELETE ON moderation_action
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER exam_audit_no_update BEFORE UPDATE ON exam_audit
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER exam_audit_no_delete BEFORE DELETE ON exam_audit
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER subsidy_audit_no_update BEFORE UPDATE ON subsidy_audit
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();
CREATE TRIGGER subsidy_audit_no_delete BEFORE DELETE ON subsidy_audit
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();

-- Bot 版本不可变（除审核状态）
CREATE OR REPLACE FUNCTION fn_bot_version_immutable() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.bot_hash IS DISTINCT FROM OLD.bot_hash
     OR NEW.package_ref IS DISTINCT FROM OLD.package_ref
     OR NEW.semver IS DISTINCT FROM OLD.semver
     OR NEW.market_manifest IS DISTINCT FROM OLD.market_manifest THEN
    RAISE EXCEPTION 'bot_version_immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER bot_version_before_update
  BEFORE UPDATE ON bot_version
  FOR EACH ROW EXECUTE FUNCTION fn_bot_version_immutable();

CREATE TRIGGER bot_version_no_delete BEFORE DELETE ON bot_version
  FOR EACH ROW EXECUTE FUNCTION fn_reject_mutation();

-- 配置类表更新即推进全局 revision（01 §4.4）
CREATE OR REPLACE FUNCTION fn_bump_config_revision() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nextval('config_sequence');
  RETURN NULL;
END;
$$;

CREATE TRIGGER provider_bump AFTER INSERT OR UPDATE OR DELETE ON provider
  FOR EACH STATEMENT EXECUTE FUNCTION fn_bump_config_revision();
CREATE TRIGGER channel_bump AFTER INSERT OR UPDATE OR DELETE ON channel
  FOR EACH STATEMENT EXECUTE FUNCTION fn_bump_config_revision();
CREATE TRIGGER channel_key_bump AFTER INSERT OR UPDATE OR DELETE ON channel_key
  FOR EACH STATEMENT EXECUTE FUNCTION fn_bump_config_revision();
CREATE TRIGGER channel_model_bump AFTER INSERT OR UPDATE OR DELETE ON channel_model
  FOR EACH STATEMENT EXECUTE FUNCTION fn_bump_config_revision();
CREATE TRIGGER public_model_bump AFTER INSERT OR UPDATE OR DELETE ON public_model
  FOR EACH STATEMENT EXECUTE FUNCTION fn_bump_config_revision();
CREATE TRIGGER route_group_bump AFTER INSERT OR UPDATE OR DELETE ON route_group
  FOR EACH STATEMENT EXECUTE FUNCTION fn_bump_config_revision();
CREATE TRIGGER route_group_member_bump AFTER INSERT OR UPDATE OR DELETE ON route_group_member
  FOR EACH STATEMENT EXECUTE FUNCTION fn_bump_config_revision();

-- =============================================================================
-- 13. 账本函数：唯一允许写 balance 的路径
-- =============================================================================

-- 13.1 预占
-- 返回 TRUE 表示成功；FALSE 表示余额不足（调用方返回 402）。
-- 必须在已开启的事务内调用；调用方负责同时插入 ai_request。
CREATE OR REPLACE FUNCTION fn_ai_reserve(
  p_owner      TEXT,
  p_request_id TEXT,
  p_amount     BIGINT,
  p_op_id      TEXT,
  p_reason     TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ok BOOLEAN := FALSE;
BEGIN
  IF p_amount < 0 OR p_amount > 9007199254740991 THEN
    RAISE EXCEPTION 'billing_amount_out_of_range' USING ERRCODE = 'check_violation';
  END IF;

  -- 单语句预占：条件 UPDATE，不先查后扣（03 §3.4）
  UPDATE balance
     SET available  = available  - p_amount,
         reserved   = reserved   + p_amount,
         updated_at = now()
   WHERE owner_user_id = p_owner
     AND available >= p_amount
  RETURNING TRUE INTO v_ok;

  IF v_ok IS NOT TRUE THEN
    RETURN FALSE;
  END IF;

  INSERT INTO ledger_entry (owner_user_id, kind, amount_micro_points, request_id, reason, actor_id, op_id)
  VALUES (p_owner, 'reserve', -p_amount, p_request_id, p_reason, 'system', p_op_id);

  RETURN TRUE;
END;
$$;

-- 13.2 结算
-- 返回 { outcome, charged, refunded }：
--   'settled'  正常结算（可能退差或补扣）
--   'review'   补扣超出可用余额，扣到 0 并转 review
--   'noop'     已是终态（幂等重放）
CREATE OR REPLACE FUNCTION fn_ai_settle(
  p_request_id TEXT,
  p_charge     BIGINT,
  p_reason     TEXT,
  p_op_id      TEXT
) RETURNS TABLE (outcome TEXT, charged BIGINT, refunded BIGINT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req      ai_request%ROWTYPE;
  v_avail    BIGINT;
  v_charged  BIGINT;
  v_refund   BIGINT;
  v_state    TEXT;
BEGIN
  SELECT * INTO v_req FROM ai_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'no_data_found';
  END IF;

  -- 幂等：已终态不再结算
  IF v_req.state = 'settled' THEN
    RETURN QUERY SELECT 'noop'::TEXT, COALESCE(v_req.charged_micro_points, 0), 0::BIGINT;
    RETURN;
  END IF;

  -- review 只能走 fn_ai_review_settle 的人工路径，不得被自动结算重复扣款
  IF v_req.state = 'review' THEN
    RAISE EXCEPTION 'request_in_review' USING ERRCODE = 'check_violation';
  END IF;

  IF p_charge < 0 OR p_charge > 9007199254740991 THEN
    RAISE EXCEPTION 'billing_amount_out_of_range' USING ERRCODE = 'check_violation';
  END IF;

  -- 锁定余额行
  SELECT available INTO v_avail FROM balance WHERE owner_user_id = v_req.owner_user_id FOR UPDATE;

  IF p_charge <= v_req.reserved_micro_points THEN
    -- 退差：reserved 减少，available 增加差额
    v_charged := p_charge;
    v_refund  := v_req.reserved_micro_points - p_charge;
    v_state   := 'settled';

    UPDATE balance
       SET reserved   = reserved   - v_req.reserved_micro_points,
           available  = available  + v_refund,
           updated_at = now()
     WHERE owner_user_id = v_req.owner_user_id;

  ELSIF p_charge <= v_req.reserved_micro_points + v_avail THEN
    -- 补扣，余额足够
    v_charged := p_charge;
    v_refund  := 0;
    v_state   := 'settled';

    UPDATE balance
       SET reserved   = reserved   - v_req.reserved_micro_points,
           available  = available  - (p_charge - v_req.reserved_micro_points),
           updated_at = now()
     WHERE owner_user_id = v_req.owner_user_id;

  ELSE
    -- 补扣不足：收预占 + 全部可用，余额归零，转 review（D-23）
    v_charged := v_req.reserved_micro_points + v_avail;
    v_refund  := 0;
    v_state   := 'review';

    UPDATE balance
       SET reserved   = reserved   - v_req.reserved_micro_points,
           available  = 0,
           updated_at = now()
     WHERE owner_user_id = v_req.owner_user_id;

    p_reason := 'usage_exceeds_reservation';
  END IF;

  UPDATE ai_request
     SET state = v_state,
         charged_micro_points = v_charged,
         settlement_reason = LEFT(p_reason, 200),
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO ledger_entry (owner_user_id, kind, amount_micro_points, request_id, reason, actor_id, op_id)
  VALUES (v_req.owner_user_id, 'settle', -v_charged, p_request_id, LEFT(p_reason, 200), 'system', p_op_id);

  IF v_refund > 0 THEN
    INSERT INTO ledger_entry (owner_user_id, kind, amount_micro_points, request_id, reason, actor_id, op_id)
    VALUES (v_req.owner_user_id, 'settle_refund', v_refund, p_request_id, 'reservation refund', 'system', p_op_id || ':refund');
  END IF;

  RETURN QUERY SELECT v_state::TEXT, v_charged, v_refund;
END;
$$;

-- 13.3 释放（全失败 / 零扣费）
CREATE OR REPLACE FUNCTION fn_ai_release(
  p_request_id TEXT,
  p_reason     TEXT,
  p_op_id      TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req ai_request%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM ai_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  IF v_req.state = 'settled' THEN
    RETURN FALSE;  -- 幂等
  END IF;

  UPDATE balance
     SET reserved   = reserved   - v_req.reserved_micro_points,
         available  = available  + v_req.reserved_micro_points,
         updated_at = now()
   WHERE owner_user_id = v_req.owner_user_id;

  UPDATE ai_request
     SET state = 'settled',
         charged_micro_points = 0,
         settlement_reason = LEFT(p_reason, 200),
         updated_at = now()
   WHERE id = p_request_id;

  INSERT INTO ledger_entry (owner_user_id, kind, amount_micro_points, request_id, reason, actor_id, op_id)
  VALUES (v_req.owner_user_id, 'settle_refund', v_req.reserved_micro_points, p_request_id,
          LEFT(p_reason, 200), 'system', p_op_id);

  RETURN TRUE;
END;
$$;

-- 13.4 运营者调整（增加/扣减积分，经审计）
CREATE OR REPLACE FUNCTION fn_ai_adjust(
  p_owner   TEXT,
  p_amount  BIGINT,   -- 正数增加，负数扣减
  p_actor   TEXT,
  p_reason  TEXT,
  p_op_id   TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_available BIGINT;
  v_ok        BOOLEAN := FALSE;
BEGIN
  IF p_amount = 0 OR p_amount < -9007199254740991 OR p_amount > 9007199254740991 THEN
    RAISE EXCEPTION 'billing_amount_out_of_range' USING ERRCODE = 'check_violation';
  END IF;

  -- 幂等：同 (kind, op_id) 已存在则直接返回当前余额
  IF EXISTS (SELECT 1 FROM ledger_entry WHERE kind = 'adjust' AND op_id = p_op_id) THEN
    SELECT available INTO v_available FROM balance WHERE owner_user_id = p_owner;
    RETURN v_available;
  END IF;

  IF p_amount > 0 THEN
    INSERT INTO balance AS b (owner_user_id, available, reserved)
    VALUES (p_owner, p_amount, 0)
    ON CONFLICT (owner_user_id) DO UPDATE
      SET available  = b.available + EXCLUDED.available,
          updated_at = now()
      WHERE b.available + EXCLUDED.available <= 9007199254740991
    RETURNING TRUE INTO v_ok;

    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'billing_amount_overflow' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    UPDATE balance
       SET available  = available + p_amount,
           updated_at = now()
     WHERE owner_user_id = p_owner
       AND available + p_amount >= 0
    RETURNING TRUE INTO v_ok;

    IF v_ok IS NOT TRUE THEN
      RAISE EXCEPTION 'insufficient_balance_for_adjustment' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  INSERT INTO ledger_entry (owner_user_id, kind, amount_micro_points, request_id, reason, actor_id, op_id)
  VALUES (p_owner, 'adjust', p_amount, NULL, LEFT(p_reason, 200), p_actor, p_op_id);

  SELECT available INTO v_available FROM balance WHERE owner_user_id = p_owner;
  RETURN v_available;
END;
$$;

-- 13.5 人工结算（review → settled，只允许向下调整）
CREATE OR REPLACE FUNCTION fn_ai_review_settle(
  p_request_id TEXT,
  p_charge     BIGINT,
  p_actor      TEXT,
  p_reason     TEXT,
  p_op_id      TEXT
) RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req ai_request%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM ai_request WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'request_not_found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_req.state <> 'review' THEN
    RAISE EXCEPTION 'request_not_in_review' USING ERRCODE = 'check_violation';
  END IF;

  -- 只能向下调整：不得超过当前已收金额（D-25 / 原稿 4.8）
  IF p_charge > COALESCE(v_req.charged_micro_points, 0) THEN
    RAISE EXCEPTION 'review_settle_not_downward' USING ERRCODE = 'check_violation';
  END IF;
  IF p_charge < 0 THEN
    RAISE EXCEPTION 'billing_amount_out_of_range' USING ERRCODE = 'check_violation';
  END IF;

  IF p_charge < COALESCE(v_req.charged_micro_points, 0) THEN
    UPDATE balance
       SET available = available + (COALESCE(v_req.charged_micro_points,0) - p_charge),
           updated_at = now()
     WHERE owner_user_id = v_req.owner_user_id;

    INSERT INTO ledger_entry (owner_user_id, kind, amount_micro_points, request_id, reason, actor_id, op_id)
    VALUES (v_req.owner_user_id, 'substitute',
            COALESCE(v_req.charged_micro_points,0) - p_charge, p_request_id,
            LEFT(p_reason, 200), p_actor, p_op_id);
  END IF;

  UPDATE ai_request
     SET state = 'settled',
         charged_micro_points = p_charge,
         settlement_reason = LEFT(p_reason, 200),
         cost_status = CASE WHEN billing_snapshot IS NULL THEN NULL ELSE 'unknown' END,
         updated_at = now()
   WHERE id = p_request_id;

  RETURN p_charge;
END;
$$;

-- =============================================================================
-- 14. 考试预算池（D-41）：并行题目共享上限
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_exam_consume_budget(
  p_exam_run_id TEXT,
  p_cost        BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ok BOOLEAN := FALSE;
BEGIN
  IF p_cost < 0 THEN
    RAISE EXCEPTION 'billing_amount_out_of_range' USING ERRCODE = 'check_violation';
  END IF;

  UPDATE exam_run
     SET budget_used_micro_points = budget_used_micro_points + p_cost
   WHERE id = p_exam_run_id
     AND state IN ('running','scoring')
     AND budget_used_micro_points + p_cost <= budget_micro_points
  RETURNING TRUE INTO v_ok;

  IF v_ok IS TRUE THEN
    RETURN TRUE;
  END IF;

  -- 超出预算：标记该场为预算耗尽，按已完成部分评分且判不通过
  UPDATE exam_run
     SET state = 'budget_exhausted',
         gate_failed = TRUE,
         gate_reason = 'budget_exhausted',
         finished_at = now()
   WHERE id = p_exam_run_id
     AND state IN ('running','scoring');

  RETURN FALSE;
END;
$$;

-- =============================================================================
-- 15. 权限
-- =============================================================================

-- 应用角色：业务表可读写
GRANT SELECT, INSERT, UPDATE ON
  provider, channel, channel_key, channel_model, public_model,
  route_group, route_group_member,
  account, user_group, ai_token,
  ai_request, request_attempt,
  ai_idempotency, points_bucket, exam_quote, exam_run,
  exam_daily_quota, bot, bot_version, bot_model_claim,
  listing, install, feedback, report,
  exam_suite, exam_case, rubric_model_allowlist,
  outbox, worker_lease, reconcile_run, billing_policy, developer
TO hezuo_app;

GRANT SELECT ON balance TO hezuo_app;

-- 只追加表：只能 SELECT/INSERT
GRANT SELECT, INSERT ON
  ledger_entry, config_audit, billing_policy_audit,
  moderation_action, exam_audit, subsidy_audit,
  channel_event, exam_case_result
TO hezuo_app;

GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO hezuo_app;

-- 函数执行权
GRANT EXECUTE ON FUNCTION
  fn_ai_reserve(TEXT, TEXT, BIGINT, TEXT, TEXT),
  fn_ai_settle(TEXT, BIGINT, TEXT, TEXT),
  fn_ai_release(TEXT, TEXT, TEXT),
  fn_ai_adjust(TEXT, BIGINT, TEXT, TEXT, TEXT),
  fn_ai_review_settle(TEXT, BIGINT, TEXT, TEXT, TEXT),
  fn_exam_consume_budget(TEXT, BIGINT)
TO hezuo_app;

-- 只读角色
GRANT SELECT ON ALL TABLES IN SCHEMA public TO hezuo_readonly;

-- 显式拒绝：即使有表级 UPDATE 也不允许改 balance（双保险，函数是唯一写路径）
REVOKE UPDATE, INSERT, DELETE ON balance FROM hezuo_app;

COMMIT;
