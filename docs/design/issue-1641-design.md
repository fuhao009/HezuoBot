# Issue #1641 — 設計

## 原因

### handoff

`roomHandoffs` の fresh work は、相手の別スレッドが `waiting-on-you` でも空き枠があると次の tick で `running` になっていた。tick は 250ms 間隔なので、enqueue から次の tick までは 0〜250ms である。検査が tick 前の `queued` を読むと通り、負荷のかかった runner は 10 秒 `running` を見て落ちる。`e8729497` でも同じで、#1637 が busy を変えたわけではない。

承認カードのあいだ fresh work を待つのは #1128 のメールボックス契約である。#1278 は resume だけをスレッド単位にし、fresh work はカードのあいだ待たせると書いた。#1589 が空き枠を認めたのは、兄弟が実際に走っているときであり、承認カードの検査は `queued` のままだった。フックがカードと実行中を区別しなくなったのが回帰で、レースがそれを隠していた。

#1626 が `expect(status).toBe("queued")` を `expect.poll(...).toBe("queued")` に変えた。状態は最初から `queued` で、tick の後に `queued` ではなくなる。poll は最初の観測が tick より後だと 10 秒 `running` を見続けて失敗する。速い観測は tick 前の `queued` で通る。マージ CI の macOS 成功と Windows 失敗、ローカルで遅延を入れると `e8729497` でも失敗すること、はこのレースで説明できる。`running` になってから承認しても、結果は 1 回だけ別スレッドに届き、開いているスレッドには `MAILBOX_REVIEW` が入らない。

### comms

`TypeError: fetch failed` / `read ECONNRESET`。#1637 の差分に `desktop/server/comms.test.ts` は無い。今回も変えない。

## 変更

- `TaskRules.tasks` も同じ一覧順で、開いている帯・閉じた帯・アーカイブの帯に分けたあと各帯の中を並べる。core の失敗で app の単体テストまで進んでいなかったので、`TaskRulesTest` の注意順期待も合わせる。KDoc も合わせる。
- fresh work の busy は、宛先スレッド、枠、グループターンに加え、他スレッドの `waiting-on-you` でも待つ。resume は #1278 のままカードでは待たない。兄弟が `working` のときの空き枠開始（#1589）は維持する。
- handoff 検査は同時スレッド数 3 のまま、承認カードが開いているあいだ ledger が tick を超えて `queued` で、別スレッドは `busy` にならないことを見る。承認のあと 1 回届くことは残す。
- `orderedThreads` は画面から呼ばれていないので、その説明を「未使用の注意順ヘルパー」に直す。

## 影響範囲

`listedThreads` / `orderedThreads` / `roomHandoffs` の busy 実装は変更しない。呼び出し元の挙動は変わらない。

## テスト

- 変更した vitest を隔離フィクスチャとして実行する。ローカルは `node:sqlite` がある Node 22.19.0。CI と `package.json` の `engines.node` は 24。この検査の期待は Node の版に依存しない。
- 変異: busy を「direct かつ bot が busy なら待たせる」に戻すと、`running` の poll が落ちる。確認後に戻す。

## 非対象
