/* live.js — 打开页面时实时抓取并渲染仪表盘
 * 依赖 calc.js（同一份计算代码，Node 对账用的也是它）
 * 设计原则：抓不到就明确报错，绝不静默显示旧数据
 */
(function () {
  'use strict';

  /* ── 数据健康横幅：无论自检是否通过、页面是否更新，都让用户一眼看到 ── */
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function bjToday() {
    var d = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function esc2(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function showStatus() {
    var el = document.getElementById('datastatus');
    if (!el) return;
    fetch('status.json?_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('no status'); return r.json(); })
      .then(function (s) {
        var today = bjToday();
        var cls, icon, text;
        if (s.ok === false) {
          cls = 'bad'; icon = '🔴';
          text = '<b>今日数据自检未通过，本次未发布新数字</b>（下面显示的是上一期，请勿据此操作）' +
                 (s.note ? '<br/>原因：' + esc2(s.note) : '');
        } else if (s.date && s.date !== today) {
          cls = 'warn'; icon = '🟡';
          text = '页面数字是 <b>' + esc2(s.date) + '</b> 的，不是今天（' + today +
                 '）。底部实时区仍是最新，可参考。';
        } else {
          cls = 'good'; icon = '🟢';
          text = '数据日期 <b>' + esc2(s.date) + '</b> ｜ 自检 ' +
                 (s.checks_total || 0) + ' 项通过 ｜ 生成于 ' + esc2(s.generated_at || '');
        }
        el.innerHTML = '<div class="statusbar ' + cls + '">' + icon + ' ' + text + '</div>';
      })
      .catch(function () {
        el.innerHTML = '<div class="statusbar warn">🟡 无法读取数据状态（status.json 未取到）' +
                       '——请勿把本页数字当作最新。</div>';
      });
  }
  showStatus();

  var box = document.getElementById('live');
  if (!box || !window.DSHCalc) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function bjNow() {
    // 北京时间
    var d = new Date(Date.now() + (8 * 60 + new Date().getTimezoneOffset()) * 60000);
    return d;
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function fail(msg) {
    box.innerHTML =
      '<div class="pcard warnbox">' +
      '<div class="ptitle">⚠️ 实时数据抓取失败</div>' +
      '<div class="cap">原因：' + esc(msg) + '<br/>' +
      '<b>下面显示的是电脑生成的那一期（可能不是最新）。</b>请勿据此判断当日盘面。</div>' +
      '</div>';
  }

  function tierCls(t) {
    if (t === '弱势') return 'b-red';
    if (t === '震荡偏弱') return 'b-amb';
    return 'b-grn';
  }

  function bar(p) {
    var cls = p >= 100 ? 'ok' : (p >= 60 ? 'near' : '');
    return '<div class="pbar"><div class="pfill ' + cls +
           '" style="width:' + Math.round(p) + '%"></div></div>';
  }

  function render(r) {
    var now = bjNow();
    var today = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    var stamp = pad(now.getHours()) + ':' + pad(now.getMinutes());

    var warns = [], notes = [];
    if (r.date !== today) {
      warns.push('数据日期 ' + r.date + ' 不是今天（' + today + '），可能是休市或接口滞后');
    }
    if (r.total && (r.total < 4700 || r.total > 5700)) {
      warns.push('涨跌家数合计 ' + r.total + ' 只，超出正常范围（约 5,200），数据可能不完整');
    }
    if (!r.zt && !r.dt) warns.push('三池返回为空，接口可能异常');
    if (r.degraded) warns.push(r.degraded);
    if (r.note) notes.push(r.note);
    if (r.redRate == null) warns.push('红盘率缺失（两个源都取不到）→ 判定已降级，请谨慎参考');
    var hm = now.getHours() * 100 + now.getMinutes();
    var intraday = (r.date === today) && hm >= 930 && hm <= 1505;
    if (intraday) warns.push('现在是盘中，数据未定稿——档位和涨跌停数还会变');

    var warnHtml = '';
    if (warns.length) {
      warnHtml += '<div class="livewarn">' + warns.map(function (w) {
        return '⚠️ ' + esc(w);
      }).join('<br/>') + '</div>';
    }
    if (notes.length) {
      warnHtml += '<div class="livenote">' + notes.map(function (n) {
        return 'ℹ️ ' + esc(n);
      }).join('<br/>') + '</div>';
    }

    var ratioTxt = r.ratio == null ? '—' : r.ratio.toFixed(2) + ' : 1';
    var ladderTxt = Object.keys(r.ladder).sort(function (a, b) { return a - b; })
      .map(function (k) { return k + '板' + r.ladder[k]; }).join(' ');

    var exRows = [
      ['中证银行', r.idx.bank], ['证券公司', r.idx.broker],
      ['创业板', r.idx.cyb], ['深证成指', r.idx.sz]
    ].map(function (p) {
      var v = p[1];
      var cls = v.excess >= 0 ? 'up' : 'down';
      return '<div class="lx"><span class="ln">' + esc(p[0]) + '</span>' +
             '<span class="lv">' + (v.chg >= 0 ? '+' : '') + v.chg.toFixed(2) + '%</span>' +
             '<span class="le ' + cls + '">' + (v.excess >= 0 ? '+' : '') +
             v.excess.toFixed(2) + 'pp</span></div>';
    }).join('');

    var cRows = (r.concepts || []).slice(0, 6).map(function (c) {
      var cls = c.chg >= 0 ? 'up' : 'down';
      return '<div class="lx"><span class="ln">' + esc(c.name) + '</span>' +
             '<span class="lv ' + cls + '">' + (c.chg >= 0 ? '+' : '') + c.chg.toFixed(2) + '%</span>' +
             '<span class="lm">涨停' + c.zt + ' 连板' + c.lb + '</span></div>';
    }).join('');

    function pctOf(v, floor, target) {
      if (target === floor) return 100;
      var p = (v - floor) / (target - floor) * 100;
      return Math.max(0, Math.min(100, p));
    }
    var okDt = r.dt <= 5, okRed = (r.redRate != null && r.redRate >= 45), okDev = r.dev20 >= 0;
    var okn = (okDt ? 1 : 0) + (okRed ? 1 : 0) + (okDev ? 1 : 0);
    var pDt = pctOf(r.dt, 100, 5);
    var pRed = (r.redRate == null) ? 0 : pctOf(r.redRate, 0, 45);
    var pDev = pctOf(r.dev20, -3, 0);
    var pAll = Math.round((pDt + pRed + pDev) / 3);

    function pitem(name, val, p, ok, gap, loS, hiS) {
      return '<div class="pitem">' +
        '<div class="phead"><span class="pname">' + name + '</span>' +
        '<span class="pcur">' + val + '</span>' +
        '<span class="pgap' + (ok ? ' ok' : '') + '">' + gap + '</span></div>' +
        '<div class="pbar2"><div class="pfill2' + (ok ? ' good' : '') +
        '" style="width:' + p.toFixed(1) + '%"></div></div>' +
        '<div class="pmeta"><span>' + loS + '</span><span>' + Math.round(p) +
        '%</span><span>' + hiS + '</span></div></div>';
    }
    var progRows =
      pitem('跌停家数', r.dt + ' 家', pDt, okDt,
            okDt ? '✓ 已达标' : '还差 ' + Math.max(0, r.dt - 5) + ' 家', '100 家', '5 家') +
      pitem('红盘率', (r.redRate == null ? '—' : r.redRate.toFixed(1) + '%'), pRed, okRed,
            okRed ? '✓ 已达标' : (r.redRate == null ? '数据缺失' : '还差 ' + (45 - r.redRate).toFixed(1) + ' 个点'),
            '0%', '45%') +
      pitem('上证 vs MA20', (r.dev20 >= 0 ? '+' : '') + r.dev20.toFixed(2) + '%', pDev, okDev,
            okDev ? '✓ 已达标' : '还差 ' + Math.abs(r.dev20).toFixed(2) + ' 个点', '−3%', '0%');

    box.innerHTML =
      '<div class="pcard livecard">' +
      '<div class="livehead"><span class="livedot"></span>实时数据' +
      '<span class="livestamp">' + r.date + ' · 抓取于 ' + stamp + '</span></div>' +
      warnHtml +
      '<div class="lvtier">' + esc(r.date) + ' 判定 ' +
      '<span class="badge ' + tierCls(r.tier) + '">' + esc(r.tier) + '</span>' +
      '<span class="lvpos">仓位 ' + r.tierPos + ' 成 · 单票 ' +
      (r.singleLots ? r.singleLots + ' 成' : '<b>0（禁止建仓）</b>') + '</span></div>' +
      '<div class="lgrid">' +
      '<div class="lcell"><span class="lk">上证</span><span class="lgv">' +
      r.sh.close.toFixed(2) + '</span><span class="ls ' +
      (r.sh.chg >= 0 ? 'up' : 'down') + '">' + (r.sh.chg >= 0 ? '+' : '') +
      r.sh.chg.toFixed(2) + '%</span></div>' +
      '<div class="lcell"><span class="lk">距 MA20</span><span class="lgv">' +
      (r.dev20 >= 0 ? '+' : '') + r.dev20.toFixed(2) + '%</span></div>' +
      '<div class="lcell"><span class="lk">涨停/跌停/炸板</span><span class="lgv">' +
      r.zt + ' / ' + r.dt + ' / ' + r.zb + '</span></div>' +
      '<div class="lcell"><span class="lk">炸板率</span><span class="lgv">' +
      r.zbRate.toFixed(1) + '%</span><span class="ls">封板 ' + r.sealRate.toFixed(1) + '%</span></div>' +
      '<div class="lcell"><span class="lk">涨跌停比</span><span class="lgv">' + ratioTxt + '</span></div>' +
      '<div class="lcell"><span class="lk">红盘率' +
      (r.redSource === 'eastmoney' ? '（东财口径）' : '') + '</span><span class="lgv">' +
      (r.redRate == null ? '—' : r.redRate.toFixed(1) + '%') +
      '</span><span class="ls">' +
      (r.redRate == null ? '两源均不可用' : r.up + '涨/' + r.down + '跌') + '</span></div>' +
      '</div>' +
      '<div class="lrow"><span class="lk">连板梯队</span>' +
      '<span class="lgv">' + esc(ladderTxt) + '</span>' +
      (r.ladderOk ? '<span class="ls ok">完整</span>'
                  : '<span class="ls bad">缺' + r.gaps.join('/') + '板</span>') + '</div>' +
      '<div class="lh">板块超额（板块 − 中证800）</div>' + exRows +
      '<div class="lh">今日题材（同花顺概念 · 按涨幅）</div>' + cRows +
      '<div class="lh">离可买入还差多少</div>' + progRows +
      '<div class="psum"><div class="psumhead">综合进度 <b>' + pAll + '%</b>' +
      '<span class="psumtag">达标 ' + okn + '/3</span></div>' +
      '<div class="pbar3"><div class="pfill3" style="width:' + pAll + '%"></div></div>' +
      '<div class="pmeta"><span>零进度</span><span>三项平均</span><span>完全达标</span></div></div>' +
      '<div class="pfoot">阈值：跌停≤5家、红盘率≥45%、上证站上MA20<br/>' +
      '本区由浏览器实时抓取计算，与电脑生成的那一期相互独立。</div>' +
      '</div>';
  }

  try {
    window.DSHCalc.computeAll().then(function (r) {
      if (!r || !r.ok) return fail((r && r.errors || []).join('; ') || '未知错误');
      render(r);
    }).catch(function (e) { fail(e && e.message || String(e)); });
  } catch (e) {
    fail(e && e.message || String(e));
  }
})();
