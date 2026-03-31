/**
 * app.js — GaryClaw Evolution Dashboard client.
 * Vanilla JS, EventSource for SSE, DOM manipulation.
 * No build step, no framework dependencies.
 */

/* global createBarChart, createSparkline, createProgressBar, createConfidenceBar, formatUsd, formatDuration, formatTime */

(function () {
  "use strict";

  // ── State ──────────────────────────────────────────────────

  var state = {
    dashboardData: null,
    decisions: [],
    mutations: [],
    growth: null,
    activityLog: [],       // Array of { time, icon, text, type }
    connected: false,
    loading: true,
    error: null,
    activeTab: "live",
    decisionSearch: "",
    decisionOffset: 0,
    decisionTotal: 0,
  };

  var MAX_ACTIVITY_LOG = 200;

  // ── DOM References ─────────────────────────────────────────

  var $ = function (id) { return document.getElementById(id); };

  // ── Tab Routing ────────────────────────────────────────────

  function setActiveTab(tab) {
    state.activeTab = tab;
    var tabs = document.querySelectorAll(".tab");
    var views = document.querySelectorAll(".view");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].classList.toggle("active", tabs[i].dataset.tab === tab);
    }
    for (var j = 0; j < views.length; j++) {
      views[j].classList.toggle("active", views[j].id === "view-" + tab);
    }
    window.location.hash = tab;
    renderActiveView();
  }

  function initTabs() {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].addEventListener("click", function () {
        setActiveTab(this.dataset.tab);
      });
    }
    // Read hash
    var hash = window.location.hash.replace("#", "") || "live";
    setActiveTab(hash);
  }

  // ── Rendering Helpers ──────────────────────────────────────

  function escapeHtml(str) {
    var div = document.createElement("div");
    div.textContent = str || "";
    return div.innerHTML;
  }

  function outcomeClass(outcome) {
    switch (outcome) {
      case "shipped": case "success": case "complete": return "badge-green";
      case "in-progress": case "partial": case "running": return "badge-amber";
      case "failed": return "badge-red";
      default: return "badge-dim";
    }
  }

  // ── Activity Log Helpers ──────────────────────────────────

  function addActivityEntry(icon, text, type) {
    var now = new Date();
    var time = ("0" + now.getHours()).slice(-2) + ":" +
               ("0" + now.getMinutes()).slice(-2) + ":" +
               ("0" + now.getSeconds()).slice(-2);
    state.activityLog.unshift({ time: time, icon: icon, text: text, type: type });
    if (state.activityLog.length > MAX_ACTIVITY_LOG) {
      state.activityLog.length = MAX_ACTIVITY_LOG;
    }
    if (state.activeTab === "live") renderActivityFeed();
  }

  function renderActivityFeed() {
    var container = document.getElementById("activity-feed");
    if (!container) return;

    if (state.activityLog.length === 0) {
      var emptyMsg = state.connected ? "Watching for events..." : "Reconnecting...";
      var dotClass = state.connected ? "pulse-dot" : "pulse-dot disconnected";
      container.innerHTML = '<div style="display: flex; align-items: center; gap: 8px; padding: 12px; color: var(--text-dim); font-size: 13px;">' +
        '<div class="' + dotClass + '"></div>' + escapeHtml(emptyMsg) + '</div>';
      return;
    }

    var html = "";
    for (var i = 0; i < state.activityLog.length; i++) {
      var entry = state.activityLog[i];
      html += '<div class="activity-line">';
      html += '<span class="activity-time">' + entry.time + '</span>';
      html += '<span class="activity-icon">' + entry.icon + '</span>';
      html += '<span class="activity-text">' + escapeHtml(entry.text) + '</span>';
      html += '</div>';
    }

    // Check if user has scrolled up before updating
    var wasScrolledToBottom = container.scrollTop + container.clientHeight >= container.scrollHeight - 50;
    container.innerHTML = html;
    if (wasScrolledToBottom) {
      container.scrollTop = 0; // newest on top, so scroll to top
    }
  }

  // ── Simple Markdown Renderer ────────────────────────────────

  function renderSimpleMarkdown(md) {
    if (!md) return "";
    var html = md
      .replace(/^---[\s\S]*?---\n?/m, "")           // strip YAML frontmatter
      .replace(/^### (.+)$/gm, "<h4>$1</h4>")        // h3 -> h4
      .replace(/^## (.+)$/gm, "<h3>$1</h3>")         // h2 -> h3
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") // bold
      .replace(/^- (.+)$/gm, "<li>$1</li>")           // bullets
      .replace(/\n{2,}/g, "<br>")                     // paragraph breaks
      .trim();
    // Wrap contiguous <li> runs in <ul>
    html = html.replace(/((?:<li>.*?<\/li>\s*)+)/g, "<ul>$1</ul>");
    return html;
  }

  function renderDomainExpertise(md) {
    if (!md) return '<div style="color: var(--text-dim); padding: 8px 0;">No domain expertise researched yet.</div>';
    // Split on ## headings, preserving the heading text
    var sections = md.split(/^## /gm).filter(Boolean);
    if (sections.length === 0) return renderSimpleMarkdown(md);

    var html = "";
    for (var i = 0; i < sections.length; i++) {
      var lines = sections[i].split("\n");
      var title = lines[0].trim();
      var body = lines.slice(1).join("\n");
      // Extract per-section YAML frontmatter
      var lastResearched = null;
      var fmMatch = body.match(/^---\n([\s\S]*?)\n---/m);
      if (fmMatch) {
        var dateMatch = fmMatch[1].match(/lastResearched:\s*(\S+)/);
        if (dateMatch) lastResearched = dateMatch[1];
        body = body.replace(/^---\n[\s\S]*?\n---\n?/m, "");
      }
      // Freshness badge
      var badge = "";
      if (lastResearched) {
        var age = (Date.now() - new Date(lastResearched).getTime()) / 86400000;
        var cls = age < 14 ? "freshness-fresh" : age < 30 ? "freshness-aging" : "freshness-stale";
        var label = age < 14 ? "fresh" : age < 30 ? "aging" : "stale";
        badge = ' <span class="freshness-badge ' + cls + '">' + label + "</span>";
      }
      html += "<h3>" + escapeHtml(title) + badge + "</h3>";
      html += renderSimpleMarkdown(body);
    }
    return html;
  }

  // ── Live Feed View ─────────────────────────────────────────

  function renderLiveFeed() {
    var d = state.dashboardData;
    if (!d) { showEmpty("view-live"); return; }

    // Activity feed section
    var dotClass = state.connected ? "pulse-dot" : "pulse-dot disconnected";
    var statusText = state.connected ? "LIVE ACTIVITY" : "RECONNECTING";
    var html = '<div class="activity-header">';
    html += '<div class="' + dotClass + '"></div>';
    html += '<span style="font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-dim);">' + statusText + '</span>';
    html += '</div>';
    html += '<div id="activity-feed" class="activity-feed"></div>';

    // Health card
    var healthColor = d.healthScore >= 80 ? "green" : d.healthScore >= 50 ? "amber" : "red";
    var healthLabel = d.healthScore >= 80 ? "HEALTHY" : d.healthScore >= 50 ? "DEGRADED" : "UNHEALTHY";

    html += '<div class="card-grid">';

    // Health
    html += '<div class="card">';
    html += '<div class="card-title">Health Score</div>';
    html += '<div class="card-value" style="color: var(--' + healthColor + ')">' + d.healthScore + '/100</div>';
    html += '<div class="card-subtitle">' + healthLabel + '</div>';
    html += '</div>';

    // Jobs today
    html += '<div class="card">';
    html += '<div class="card-title">Jobs Today</div>';
    html += '<div class="card-value">' + (d.jobs ? d.jobs.total : 0) + '</div>';
    html += '<div class="card-subtitle">' + (d.jobs ? d.jobs.complete : 0) + ' complete, ' + (d.jobs ? d.jobs.failed : 0) + ' failed</div>';
    html += '</div>';

    // Budget
    html += '<div class="card">';
    html += '<div class="card-title">Daily Budget</div>';
    html += '<div class="card-value">' + formatUsd(d.budget ? d.budget.dailySpentUsd : 0) + '</div>';
    html += '<div class="card-subtitle">of ' + formatUsd(d.budget ? d.budget.dailyLimitUsd : 0) + ' limit</div>';
    if (d.budget && d.budget.dailyLimitUsd > 0) {
      var budgetPct = (d.budget.dailySpentUsd / d.budget.dailyLimitUsd) * 100;
      html += createProgressBar(100 - budgetPct);
    }
    html += '</div>';

    // Oracle
    html += '<div class="card">';
    html += '<div class="card-title">Oracle</div>';
    html += '<div class="card-value">' + (d.oracle ? d.oracle.totalDecisions : 0) + ' decisions</div>';
    html += '<div class="card-subtitle">' + (d.oracle ? d.oracle.accuracyPercent.toFixed(0) : 0) + '% accuracy, ' +
      (d.oracle ? d.oracle.confidenceAvg.toFixed(1) : 0) + ' avg confidence</div>';
    html += '</div>';

    html += '</div>'; // card-grid

    // Top concern
    if (d.topConcern) {
      html += '<div class="card" style="border-left: 3px solid var(--amber)">';
      html += '<div class="card-title">Top Concern</div>';
      html += '<div>' + escapeHtml(d.topConcern) + '</div>';
      html += '</div>';
    }

    // Job success rate bar
    if (d.jobs && d.jobs.total > 0) {
      html += '<div class="card">';
      html += '<div class="card-title">Job Success Rate</div>';
      html += '<div style="display: flex; align-items: center; gap: 12px;">';
      html += '<div style="flex: 1">' + createProgressBar(d.jobs.successRate) + '</div>';
      html += '<span style="font-family: var(--font-mono); font-weight: 600">' + d.jobs.successRate.toFixed(0) + '%</span>';
      html += '</div>';
      html += '</div>';
    }

    // Instances
    if (d.instances && d.instances.length > 0) {
      html += '<div class="card">';
      html += '<div class="card-title">Active Instances</div>';
      html += '<div style="display: flex; gap: 8px; flex-wrap: wrap;">';
      for (var i = 0; i < d.instances.length; i++) {
        html += '<span class="badge badge-blue">' + escapeHtml(d.instances[i]) + '</span>';
      }
      html += '</div>';
      html += '</div>';
    }

    // Skill costs
    if (d.skillCosts && d.skillCosts.skills && d.skillCosts.skills.length > 0) {
      html += '<div class="card">';
      html += '<div class="card-title">Skill Costs</div>';
      html += '<div class="table-container"><table>';
      html += '<tr><th>Skill</th><th>Runs</th><th>Avg Cost</th><th>Total</th></tr>';
      for (var s = 0; s < d.skillCosts.skills.length; s++) {
        var sk = d.skillCosts.skills[s];
        html += '<tr><td>' + escapeHtml(sk.skillName) + '</td>';
        html += '<td>' + sk.runCount + '</td>';
        html += '<td>' + formatUsd(sk.avgCostUsd) + '</td>';
        html += '<td>' + formatUsd(sk.totalCostUsd) + '</td></tr>';
      }
      html += '</table></div>';
      html += '</div>';
    }

    $("view-live").innerHTML = html;
    // Populate activity feed after DOM update
    renderActivityFeed();
  }

  // ── Mutation Timeline View ─────────────────────────────────

  function renderMutations() {
    var el = $("view-mutations");
    if (!state.mutations || state.mutations.length === 0) {
      showEmpty("view-mutations", "No mutation cycles recorded yet.");
      return;
    }

    var html = '<div class="timeline">';
    for (var i = 0; i < state.mutations.length; i++) {
      var m = state.mutations[i];
      html += '<div class="timeline-item">';
      html += '<div class="timeline-dot ' + m.outcome + '"></div>';
      html += '<div class="timeline-title">' + escapeHtml(m.todoTitle) + '</div>';
      html += '<div class="timeline-meta">';
      html += '<span class="badge ' + outcomeClass(m.outcome) + '">' + m.outcome + '</span>';
      html += ' &middot; ' + formatUsd(m.costUsd);
      html += ' &middot; ' + formatTime(m.startedAt);
      if (m.completedAt) html += ' &rarr; ' + formatTime(m.completedAt);
      html += '</div>';

      if (m.skills && m.skills.length > 0) {
        html += '<div class="timeline-skills">';
        for (var j = 0; j < m.skills.length; j++) {
          var sk = m.skills[j];
          var skClass = sk.status === "complete" ? "badge-green" :
                       sk.status === "failed" ? "badge-red" : "badge-dim";
          html += '<span class="badge ' + skClass + '">' + escapeHtml(sk.name) + '</span>';
        }
        html += '</div>';
      }

      html += '</div>';
    }
    html += '</div>';

    el.innerHTML = html;
  }

  // ── Growth Over Time View ──────────────────────────────────

  function renderGrowth() {
    var el = $("view-growth");
    if (!state.growth || !state.growth.snapshots || state.growth.snapshots.length === 0) {
      showEmpty("view-growth", "Growth data not yet cached. Start the server to build the cache.");
      return;
    }

    var snapshots = state.growth.snapshots;
    var html = '';

    // Module count chart
    html += '<div class="card">';
    html += '<div class="card-title">Source Modules Over Time</div>';
    html += '<div id="chart-modules" class="bar-chart"></div>';
    html += '</div>';

    // Test count chart
    html += '<div class="card">';
    html += '<div class="card-title">Tests Over Time</div>';
    html += '<div id="chart-tests" class="bar-chart"></div>';
    html += '</div>';

    // Commits chart (human vs daemon)
    html += '<div class="card">';
    html += '<div class="card-title">Commits (Human vs Daemon)</div>';
    html += '<div id="chart-commits" class="bar-chart"></div>';
    html += '</div>';

    // Module attribution grid
    if (state.growth.moduleAttribution) {
      html += '<div class="card">';
      html += '<div class="card-title">Module Attribution</div>';
      html += '<div class="module-grid">';
      var attrs = state.growth.moduleAttribution;
      var modules = Object.keys(attrs).sort();
      for (var i = 0; i < modules.length; i++) {
        var mod = modules[i];
        var author = attrs[mod];
        var authorClass = author === "daemon" ? "badge-green" : "badge-blue";
        html += '<div class="module-item">';
        html += '<span>' + escapeHtml(mod) + '</span>';
        html += '<span class="badge ' + authorClass + '">' + author + '</span>';
        html += '</div>';
      }
      html += '</div>';
      html += '</div>';
    }

    el.innerHTML = html;

    // Render charts after DOM is updated
    var last20 = snapshots.slice(-20);

    var moduleData = last20.map(function (s) {
      return { label: s.date.slice(5), value: s.modules, tooltip: s.date + ": " + s.modules + " modules" };
    });
    var chartModules = document.getElementById("chart-modules");
    if (chartModules) createBarChart(chartModules, moduleData, { defaultColor: "var(--accent)" });

    var testData = last20.map(function (s) {
      return { label: s.date.slice(5), value: s.tests, tooltip: s.date + ": " + s.tests + " tests", color: "var(--green)" };
    });
    var chartTests = document.getElementById("chart-tests");
    if (chartTests) createBarChart(chartTests, testData);

    var commitData = last20.map(function (s) {
      return { label: s.date.slice(5), value: s.commits, tooltip: s.date + ": " + s.humanCommits + " human, " + s.daemonCommits + " daemon" };
    });
    var chartCommits = document.getElementById("chart-commits");
    if (chartCommits) createBarChart(chartCommits, commitData, { defaultColor: "var(--purple)" });
  }

  // ── Oracle Mind View ───────────────────────────────────────

  function renderOracleMind() {
    var el = $("view-mind");
    var d = state.dashboardData;
    if (!d) { showEmpty("view-mind"); return; }

    var html = '';

    // Oracle stats cards
    html += '<div class="card-grid">';

    html += '<div class="card">';
    html += '<div class="card-title">Total Decisions</div>';
    html += '<div class="card-value">' + (d.oracle ? d.oracle.totalDecisions : 0) + '</div>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="card-title">Accuracy</div>';
    html += '<div class="card-value">' + (d.oracle ? d.oracle.accuracyPercent.toFixed(1) : 0) + '%</div>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="card-title">Avg Confidence</div>';
    html += '<div class="card-value">' + (d.oracle ? d.oracle.confidenceAvg.toFixed(1) : 0) + '/10</div>';
    html += '</div>';

    html += '<div class="card">';
    html += '<div class="card-title">Circuit Breaker</div>';
    var cbTripped = d.oracle && d.oracle.circuitBreakerTripped;
    html += '<div class="card-value" style="color: var(--' + (cbTripped ? "red" : "green") + ')">' +
      (cbTripped ? "TRIPPED" : "OK") + '</div>';
    html += '</div>';

    html += '</div>';

    // Confidence sparkline
    if (d.oracle && d.oracle.confidenceAvg > 0) {
      html += '<div class="card">';
      html += '<div class="card-title">Confidence Trend (last 20)</div>';
      // Use confidence trend from decisions
      var confValues = state.decisions.slice(0, 20).map(function (d) { return d.confidence; }).reverse();
      if (confValues.length >= 2) {
        html += createSparkline(confValues, { width: 300, height: 40, color: "var(--green)" });
      } else {
        html += '<div class="text-dim">Not enough data for sparkline</div>';
      }
      html += '</div>';
    }

    // Decision search and log
    html += '<div class="card">';
    html += '<div class="card-title">Decision Log (' + state.decisionTotal + ' total)</div>';
    html += '<input type="text" class="search-box" id="decision-search" placeholder="Search decisions..." value="' + escapeHtml(state.decisionSearch) + '">';

    if (state.decisions.length > 0) {
      html += '<div class="table-container"><table>';
      html += '<tr><th>Confidence</th><th>Question</th><th>Chosen</th><th>Outcome</th><th>Principle</th></tr>';

      var filtered = state.decisions;
      if (state.decisionSearch) {
        var q = state.decisionSearch.toLowerCase();
        filtered = filtered.filter(function (d) {
          return d.question.toLowerCase().indexOf(q) >= 0 || d.chosen.toLowerCase().indexOf(q) >= 0;
        });
      }

      for (var i = 0; i < Math.min(filtered.length, 50); i++) {
        var dec = filtered[i];
        html += '<tr>';
        html += '<td>' + createConfidenceBar(dec.confidence) + ' ' + dec.confidence + '</td>';
        html += '<td>' + escapeHtml(dec.question) + '</td>';
        html += '<td><strong>' + escapeHtml(dec.chosen) + '</strong></td>';
        html += '<td><span class="badge ' + outcomeClass(dec.outcome) + '">' + dec.outcome + '</span></td>';
        html += '<td style="font-size: 11px; color: var(--text-dim)">' + escapeHtml(dec.principle) + '</td>';
        html += '</tr>';
      }
      html += '</table></div>';

      if (state.decisionTotal > state.decisions.length) {
        html += '<div style="text-align: center; padding: 12px;">';
        html += '<button id="load-more-decisions" style="background: var(--surface-raised); border: 1px solid var(--border); color: var(--accent); padding: 6px 16px; border-radius: var(--radius); cursor: pointer;">Load More</button>';
        html += '</div>';
      }
    } else {
      html += '<div class="empty-state"><p>No decisions recorded yet.</p></div>';
    }

    html += '</div>';

    // Taste Profile card
    html += '<div class="card oracle-content-card">';
    html += '<div class="card-title">Taste Profile</div>';
    if (d.tasteProfile) {
      html += renderSimpleMarkdown(d.tasteProfile);
    } else {
      html += '<div style="color: var(--text-dim); padding: 8px 0;">No taste profile learned yet.</div>';
    }
    html += '</div>';

    // Domain Expertise card
    html += '<div class="card oracle-content-card">';
    html += '<div class="card-title">Domain Expertise</div>';
    html += renderDomainExpertise(d.domainExpertise);
    html += '</div>';

    el.innerHTML = html;

    // Bind search
    var searchInput = document.getElementById("decision-search");
    if (searchInput) {
      searchInput.addEventListener("input", function () {
        state.decisionSearch = this.value;
        renderOracleMind();
      });
    }

    // Bind load more
    var loadMoreBtn = document.getElementById("load-more-decisions");
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", function () {
        loadMoreDecisions();
      });
    }
  }

  // ── Shared Render Helpers ──────────────────────────────────

  function showEmpty(viewId, message) {
    var el = $(viewId);
    if (el) {
      el.innerHTML = '<div class="empty-state"><p>' +
        escapeHtml(message || 'No data yet. Start the daemon with `garyclaw daemon start` to begin.') +
        '</p></div>';
    }
  }

  function renderActiveView() {
    switch (state.activeTab) {
      case "live": renderLiveFeed(); break;
      case "mutations": renderMutations(); break;
      case "growth": renderGrowth(); break;
      case "mind": renderOracleMind(); break;
    }
  }

  function updateFooter() {
    var d = state.dashboardData;
    if (!d) return;
    var footer = $("footer");
    if (!footer) return;
    footer.innerHTML =
      '<span><span class="stat-value">' + d.healthScore + '/100</span><span class="stat-label">Health</span></span>' +
      '<span><span class="stat-value">' + (d.jobs ? d.jobs.total : 0) + '</span><span class="stat-label">Jobs today</span></span>' +
      '<span><span class="stat-value">' + formatUsd(d.budget ? d.budget.dailySpentUsd : 0) + '</span><span class="stat-label">Spent</span></span>';
  }

  function setConnectionStatus(connected) {
    state.connected = connected;
    var dot = $("connection-dot");
    if (dot) {
      dot.className = "connection-dot " + (connected ? "connected" : "disconnected");
    }
  }

  function showError(message) {
    state.error = message;
    var banner = $("error-banner");
    if (banner) {
      banner.textContent = "Dashboard error: " + message + ". Retrying...";
      banner.classList.add("visible");
    }
  }

  function clearError() {
    state.error = null;
    var banner = $("error-banner");
    if (banner) banner.classList.remove("visible");
  }

  // ── Data Loading ───────────────────────────────────────────

  function loadInitialData() {
    state.loading = true;

    // Load all data in parallel
    Promise.all([
      fetch("/api/state").then(function (r) { return r.json(); }),
      fetch("/api/decisions?limit=50&offset=0").then(function (r) { return r.json(); }),
      fetch("/api/mutations?limit=20").then(function (r) { return r.json(); }),
      fetch("/api/growth").then(function (r) { return r.json(); }),
    ]).then(function (results) {
      state.dashboardData = results[0];
      var decData = results[1];
      state.decisions = decData.decisions || [];
      state.decisionTotal = decData.total || 0;
      state.decisionOffset = state.decisions.length;
      var mutData = results[2];
      state.mutations = mutData.cycles || [];
      state.growth = results[3];
      state.loading = false;
      clearError();
      renderActiveView();
      updateFooter();
    }).catch(function (err) {
      state.loading = false;
      showError(err.message || "Failed to load data");
      // Retry after 5s
      setTimeout(loadInitialData, 5000);
    });
  }

  function loadMoreDecisions() {
    var offset = state.decisionOffset;
    fetch("/api/decisions?limit=50&offset=" + offset)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.decisions && data.decisions.length > 0) {
          state.decisions = state.decisions.concat(data.decisions);
          state.decisionOffset = state.decisions.length;
          state.decisionTotal = data.total;
          if (state.activeTab === "mind") renderOracleMind();
        }
      })
      .catch(function () { /* best-effort */ });
  }

  // ── SSE Connection ─────────────────────────────────────────

  function connectSSE() {
    var source = new EventSource("/api/events");

    source.addEventListener("open", function () {
      setConnectionStatus(true);
      clearError();
    });

    source.addEventListener("error", function () {
      setConnectionStatus(false);
      // EventSource auto-reconnects
    });

    source.addEventListener("init", function (event) {
      try {
        state.dashboardData = JSON.parse(event.data);
        renderActiveView();
        updateFooter();
      } catch (e) { /* ignore parse errors */ }
    });

    source.addEventListener("job_update", function (event) {
      try {
        var data = JSON.parse(event.data);
        if (state.dashboardData) {
          if (data.jobs) state.dashboardData.jobs = data.jobs;
          if (data.healthScore !== undefined) state.dashboardData.healthScore = data.healthScore;
          if (data.budget) state.dashboardData.budget = data.budget;
        }
        var jobText = "Job update";
        if (data.jobs) jobText = "Jobs: " + data.jobs.total + " total, " + data.jobs.complete + " complete";
        addActivityEntry("\uD83D\uDCBC", jobText, "job_update");
        if (state.activeTab === "live") renderLiveFeed();
        updateFooter();
      } catch (e) { /* ignore */ }
    });

    source.addEventListener("budget", function (event) {
      try {
        var data = JSON.parse(event.data);
        if (state.dashboardData && data.budget) {
          state.dashboardData.budget = data.budget;
        }
        var budgetText = "Budget updated";
        if (data.budget) budgetText = "Budget: " + formatUsd(data.budget.dailySpentUsd) + " spent today";
        addActivityEntry("\uD83D\uDCB2", budgetText, "budget");
        if (state.activeTab === "live") renderLiveFeed();
        updateFooter();
      } catch (e) { /* ignore */ }
    });

    source.addEventListener("decision", function (event) {
      try {
        var dec = JSON.parse(event.data);
        if (dec.id) {
          state.decisions.unshift(dec);
          state.decisionTotal++;
          var decText = "Oracle: \"" + (dec.chosen || "?") + "\" (" + (dec.confidence || "?") + "/10)";
          addActivityEntry("\uD83E\uDDE0", decText, "decision");
          if (state.activeTab === "mind") renderOracleMind();
        }
      } catch (e) { /* ignore */ }
    });

    source.addEventListener("mutation", function (event) {
      try {
        var mutData = JSON.parse(event.data);
        var mutText = "Mutation";
        if (mutData.todoTitle) mutText = "Mutation " + (mutData.outcome || "") + ": " + mutData.todoTitle;
        addActivityEntry("\uD83E\uDDEC", mutText, "mutation");
        // Reload mutations on any change
        fetch("/api/mutations?limit=20")
          .then(function (r) { return r.json(); })
          .then(function (data) {
            state.mutations = data.cycles || [];
            if (state.activeTab === "mutations") renderMutations();
          });
      } catch (e) { /* ignore */ }
    });

    function handleOracleFileUpdate(icon, text, eventType) {
      addActivityEntry(icon, text, eventType);
      fetch("/api/state").then(function (r) { return r.json(); }).then(function (data) {
        state.dashboardData = data;
        if (state.activeTab === "mind") renderOracleMind();
      }).catch(function () { /* best-effort */ });
    }

    source.addEventListener("taste_update", function () {
      handleOracleFileUpdate("\u2728", "Taste profile updated", "taste_update");
    });

    source.addEventListener("expertise_update", function () {
      handleOracleFileUpdate("\uD83D\uDCDA", "Domain expertise updated", "expertise_update");
    });
  }

  // ── Init ───────────────────────────────────────────────────

  function init() {
    initTabs();
    loadInitialData();
    connectSSE();
  }

  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
