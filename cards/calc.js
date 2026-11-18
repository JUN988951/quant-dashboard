/* calc.js — 决策清单共享计算模块
 * 同一份代码跑在「浏览器」和「Node」两个环境：
 *   浏览器：页面打开时实时抓取 + 计算
 *   Node  ：我用来和 Python 参考实现逐项对账
 * 口径严格对齐《基础规则库》v2.0（§1 四档复合判定 / §5.5 / §6）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DSHCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EM_UT = '7eea3edcaed734bea9cbfc24409ed989';
  var IDX = {
    sh:      { code: 'sh000001', name: '上证指数' },
    sz:      { code: 'sz399001', name: '深证成指' },
    cyb:     { code: 'sz399006', name: '创业板指' },
    csi800:  { code: 'sh000906', name: '中证800' },
    bank:    { code: 'sz399986', name: '中证银行' },
    broker:  { code: 'sz399975', name: '证券公司' }
  };

  function getJSON(url) {
    // 注意：不能传自定义 headers / cache:'no-store'，否则浏览器会发预检 OPTIONS，
    // 而部分接口不支持预检会直接失败。用时间戳参数绕过缓存即可（仍是「简单请求」）。
    var u = url + (url.indexOf('?') >= 0 ? '&' : '?') + '_=' + Date.now();
    return fetch(u).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url.split('?')[0]);
      return r.text();
    }).then(function (t) {
      try { return JSON.parse(t); } catch (e) { throw new Error('JSON 解析失败'); }
    });
  }

  function kline(code, n) {
    var tu = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
             code + ',day,,,' + n + ',qfq';
    return getJSON(tu).then(function (j) {
      var d = j && j.data && j.data[code];
      if (!d || !d.day || !d.day.length) throw new Error('腾讯K线为空 ' + code);
      return { day: d.day, qt: d.qt || {}, code: code, src: 'tencent' };
    }).catch(function () {
      // 备用：东财日K（支持 CORS，但没有涨跌家数字段）
      var secid = (code.indexOf('sh') === 0 ? '1.' : '0.') + code.slice(2);
      var eu = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + secid +
               '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56' +
               '&klt=101&fqt=1&end=20500101&lmt=' + n;
      return getJSON(eu).then(function (j) {
        var d = j && j.data;
        if (!d || !d.klines || !d.klines.length) throw new Error('备用K线为空 ' + code);
        var day = d.klines.map(function (s) {
          var a = s.split(',');
          return [a[0], a[1], a[2], a[3], a[4], a[5]];  // 日期,开,收,高,低,量
        });
        return { day: day, qt: {}, code: code, src: 'eastmoney' };
      });
    });
  }

  function pool(kind, date) {
    var u = 'https://push2ex.eastmoney.com/getTopic' + kind + 'Pool?ut=' + EM_UT +
            '&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=fbt:asc&date=' + date;
    return getJSON(u).then(function (j) {
      var d = (j && j.data) || {};
      return { tc: d.tc || 0, pool: d.pool || [] };
    });
  }

  function concepts(date) {
    var u = 'https://data.10jqka.com.cn/dataapi/limit_up/block_top?filter=HS,GEM2STAR&date=' + date;
    return getJSON(u).then(function (j) { return (j && j.data) || []; });
  }

  function pct(a, b) { return b ? (a - b) / b * 100 : 0; }
  function ma(arr, n) {
    if (arr.length < n) n = arr.length;
    var s = 0; for (var i = arr.length - n; i < arr.length; i++) s += arr[i];
    return s / n;
  }
  function r1(v) { return Math.round(v * 10) / 10; }
  function r2(v) { return Math.round(v * 100) / 100; }

  /* §1 四档复合判定（红盘率缺失时自动跳过该项，并标记降级） */
  function tierOf(m) {
    var red = (m.redRate == null) ? null : m.redRate;
    if (m.shChg < -1.5 || m.dt > 15 || (red != null && red < 30)) return '弱势';
    var ratio = m.dt > 0 ? m.zt / m.dt : 99;
    if (m.shChg > 0.5 && ratio >= 3 && m.ladderOk && m.zbRate < 20) return '强势';
    if (m.shChg >= -0.5 && m.shChg <= 0.5 && ratio >= 1 && m.ladderOk && m.zbRate < 40)
      return '震荡偏强';
    return '震荡偏弱';
  }

  var TIER_POS = {
    '强势': 8, '震荡偏强': 5, '震荡偏弱': 3, '弱势': 2
  };
  var TIER_SINGLE = {   // 开关表：单票额度（成）
    '强势': 2, '震荡偏强': 2, '震荡偏弱': 1, '弱势': 0
  };

  function computeAll() {
    var out = { ok: false, errors: [] };
    var date = null;
    var shK = null;              // 沪市 K 线（含 zhishu 涨跌家数）

    return kline(IDX.sh.code, 250).then(function (sh) {
      shK = sh;
      var day = sh.day;
      date = day[day.length - 1][0];
      var closes = day.map(function (x) { return +x[2]; });
      var last = closes[closes.length - 1], prev = closes[closes.length - 2];
      out.date = date;
      out.sh = {
        close: r2(last),
        chg: r2(pct(last, prev)),
        ma5: r2(ma(closes, 5)), ma10: r2(ma(closes, 10)),
        ma20: r2(ma(closes, 20)), ma60: r2(ma(closes, 60)),
        dev20: r2(pct(last, ma(closes, 20))),
        closes5: closes.slice(-5).map(r2),
        src: sh.src
      };
      out.shChg = out.sh.chg;
      out.dev20 = out.sh.dev20;
      out.ma20 = out.sh.ma20;

      var d8 = date.replace(/-/g, '');
      out.tradeDate = d8;

      return Promise.all([
        kline(IDX.sz.code, 30), kline(IDX.cyb.code, 30),
        kline(IDX.csi800.code, 30), kline(IDX.bank.code, 30),
        kline(IDX.broker.code, 30),
        pool('ZT', d8), pool('DT', d8), pool('ZB', d8),
        concepts(d8)
      ]);
    }).then(function (res) {
      var sz = res[0], cyb = res[1], c8 = res[2], bk = res[3], br = res[4];
      var zt = res[5], dt = res[6], zb = res[7], cb = res[8];

      function series(k) {
        var c = k.day.map(function (x) { return +x[2]; });
        var last = c[c.length - 1], prev = c[c.length - 2];
        return {
          close: r2(last), chg: r2(pct(last, prev)),
          chg5: c.length >= 6 ? r2(pct(last, c[c.length - 6])) : 0,
          dev20: r2(pct(last, ma(c, 20)))
        };
      }
      var base = series(c8).chg;
      out.idx = {
        sz: series(sz), cyb: series(cyb), csi800: series(c8),
        bank: series(bk), broker: series(br)
      };
      out.idx.bank.excess = r2(out.idx.bank.chg - base);
      out.idx.broker.excess = r2(out.idx.broker.chg - base);
      out.idx.cyb.excess = r2(out.idx.cyb.chg - base);
      out.idx.sz.excess = r2(out.idx.sz.chg - base);
      out.base = base;

      /* 红盘率：沪市 + 深市（两个市场各取一次） */
      var z1 = (shK.qt && shK.qt.zhishu) || [];
      var z2 = (sz.qt && sz.qt.zhishu) || [];
      var up = (+z1[2] || 0) + (+z2[2] || 0);
      var flat = (+z1[3] || 0) + (+z2[3] || 0);
      var down = (+z1[4] || 0) + (+z2[4] || 0);
      var tot = up + flat + down;
      out.up = up; out.down = down; out.flat = flat; out.total = tot;
      if (tot > 0) {
        out.redRate = r1(up / tot * 100);
      } else {
        out.redRate = null;                    // 备用数据源无涨跌家数
        out.degraded = '红盘率缺失（K线走了备用源），该项不参与判定';
      }

      /* 情绪 */
      out.zt = zt.tc; out.dt = dt.tc; out.zb = zb.tc;
      out.zbRate = (zt.tc + zb.tc) ? r1(zb.tc / (zt.tc + zb.tc) * 100) : 0;
      out.sealRate = (zt.tc + zb.tc) ? r1(zt.tc / (zt.tc + zb.tc) * 100) : 0;
      out.ratio = dt.tc ? r2(zt.tc / dt.tc) : null;

      /* 连板梯队 */
      var lb = {};
      zt.pool.forEach(function (x) {
        var n = +x.lbc || 1;
        lb[n] = (lb[n] || 0) + 1;
      });
      out.ladder = lb;
      var hi = 0;
      Object.keys(lb).forEach(function (k) { if (+k > hi) hi = +k; });
      out.highest = hi;
      out.topNames = zt.pool.filter(function (x) { return (+x.lbc || 1) === hi; })
                             .map(function (x) { return x.n; });
      var gaps = [];
      for (var i = 2; i <= hi; i++) if (!lb[i]) gaps.push(i);
      out.gaps = gaps;
      out.gapFilled = gaps.length === 0;
      out.ladderOk = !!(lb[2] && lb[3] && lb[4]);   // §1 字面：2/3/4 都有票

      /* 板块（涨停家数） */
      var bkCount = {};
      zt.pool.forEach(function (x) {
        var b = x.hybk || '?';
        bkCount[b] = (bkCount[b] || 0) + 1;
      });
      out.sectorTop = Object.keys(bkCount)
        .map(function (k) { return { name: k, n: bkCount[k] }; })
        .sort(function (a, b) { return b.n - a.n; }).slice(0, 6);

      /* 概念题材（同花顺，按涨幅） */
      var cs = cb.filter(function (x) { return x.change != null; })
                 .sort(function (a, b) { return b.change - a.change; })
                 .slice(0, 10)
                 .map(function (x) {
                   return {
                     name: x.name, chg: r2(x.change),
                     zt: x.limit_up_num || 0, lb: x.continuous_plate_num || 0,
                     excess: r2(x.change - base)
                   };
                 });
      out.concepts = cs;

      /* 档位 */
      out.tier = tierOf(out);
      out.tierPos = TIER_POS[out.tier];
      out.singleLots = TIER_SINGLE[out.tier];

      /* 恢复进度（0%→100%） */
      function prog(v, floor, target) {
        if (target === floor) return 100;
        var p = (v - floor) / (target - floor) * 100;
        return Math.max(0, Math.min(100, p));
      }
      out.progress = {
        dt: r1(prog(out.dt, 60, 5)),
        red: (out.redRate == null) ? null : r1(prog(out.redRate, 10, 45)),
        dev: r1(prog(out.dev20, -2, 0))
      };
      var pg = [out.progress.dt, out.progress.dev];
      if (out.progress.red != null) pg.push(out.progress.red);
      out.progressAll = Math.round(pg.reduce(function (a, b) { return a + b; }, 0) / pg.length);

      if (shK && shK.src === 'eastmoney')
        out.degraded = 'K线走了备用数据源（东财），红盘率缺失';

      out.ok = true;
      out.fetchedAt = new Date().toISOString();
      return out;
    }).catch(function (e) {
      out.ok = false;
      out.errors.push(String(e && e.message || e));
      return out;
    });
  }

  return { computeAll: computeAll, tierOf: tierOf, version: '1.0' };
});
