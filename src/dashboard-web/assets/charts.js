/**
 * charts.js — Lightweight chart rendering for GaryClaw dashboard.
 * CSS bar charts + inline SVG sparklines. No dependencies.
 */

/* exported createBarChart, createSparkline, createProgressBar, createConfidenceBar */

/**
 * Create a CSS bar chart inside a container element.
 * @param {HTMLElement} container
 * @param {Array<{label: string, value: number, color?: string, tooltip?: string}>} data
 * @param {object} [opts]
 * @param {number} [opts.maxValue] - Override max value (default: auto from data)
 * @param {string} [opts.defaultColor] - Default bar color CSS variable
 */
function createBarChart(container, data, opts) {
  opts = opts || {};
  container.innerHTML = "";
  container.classList.add("bar-chart");

  if (!data || data.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No data</p></div>';
    return;
  }

  var maxVal = opts.maxValue || Math.max.apply(null, data.map(function(d) { return d.value; }));
  if (maxVal === 0) maxVal = 1;

  for (var i = 0; i < data.length; i++) {
    var d = data[i];
    var pct = Math.min(100, (d.value / maxVal) * 100);
    var bar = document.createElement("div");
    bar.className = "bar";
    bar.style.height = Math.max(2, pct) + "%";
    bar.style.background = d.color || opts.defaultColor || "var(--accent)";

    if (d.tooltip || d.label) {
      var tip = document.createElement("div");
      tip.className = "tooltip";
      tip.textContent = d.tooltip || d.label + ": " + d.value;
      bar.appendChild(tip);
    }

    if (d.label) {
      var label = document.createElement("div");
      label.className = "bar-label";
      label.textContent = d.label;
      bar.appendChild(label);
    }

    container.appendChild(bar);
  }
}

/**
 * Create an inline SVG sparkline.
 * @param {Array<number>} values - Data points
 * @param {object} [opts]
 * @param {number} [opts.width] - SVG width (default: 100)
 * @param {number} [opts.height] - SVG height (default: 24)
 * @param {string} [opts.color] - Stroke color
 * @returns {string} SVG markup string
 */
function createSparkline(values, opts) {
  opts = opts || {};
  var w = opts.width || 100;
  var h = opts.height || 24;
  var color = opts.color || "var(--accent)";

  if (!values || values.length < 2) {
    return '<svg class="sparkline" width="' + w + '" height="' + h + '"></svg>';
  }

  var max = Math.max.apply(null, values);
  var min = Math.min.apply(null, values);
  var range = max - min || 1;

  var points = [];
  for (var i = 0; i < values.length; i++) {
    var x = (i / (values.length - 1)) * w;
    var y = h - ((values[i] - min) / range) * (h - 4) - 2;
    points.push(x.toFixed(1) + "," + y.toFixed(1));
  }

  return '<svg class="sparkline" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">' +
    '<polyline points="' + points.join(" ") + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
}

/**
 * Create a progress bar element.
 * @param {number} value - Current value (0-100)
 * @param {object} [opts]
 * @param {string} [opts.color] - Override color class (green/amber/red)
 * @returns {string} HTML string
 */
function createProgressBar(value, opts) {
  opts = opts || {};
  var colorClass = opts.color || (value >= 80 ? "green" : value >= 50 ? "amber" : "red");
  return '<div class="progress-bar"><div class="progress-fill ' + colorClass + '" style="width: ' + Math.min(100, Math.max(0, value)) + '%"></div></div>';
}

/**
 * Create a confidence bar (10 dots).
 * @param {number} confidence - Value 1-10
 * @returns {string} HTML string
 */
function createConfidenceBar(confidence) {
  var html = '<span class="confidence-bar">';
  for (var i = 1; i <= 10; i++) {
    var filled = i <= confidence;
    var cls = "dot";
    if (filled) {
      cls += " filled";
      if (confidence <= 3) cls += " low";
      else if (confidence <= 6) cls += " medium";
    }
    html += '<span class="' + cls + '"></span>';
  }
  html += '</span>';
  return html;
}

/**
 * Format a number as USD currency.
 * @param {number} value
 * @returns {string}
 */
function formatUsd(value) {
  return "$" + (value || 0).toFixed(2);
}

/**
 * Format seconds into a human-readable duration.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  if (!seconds || seconds < 1) return "0s";
  if (seconds < 60) return Math.round(seconds) + "s";
  if (seconds < 3600) return Math.round(seconds / 60) + "m";
  return (seconds / 3600).toFixed(1) + "h";
}

/**
 * Format an ISO timestamp to a short relative or absolute string.
 * @param {string} isoStr
 * @returns {string}
 */
function formatTime(isoStr) {
  if (!isoStr) return "-";
  try {
    var d = new Date(isoStr);
    var now = Date.now();
    var diff = now - d.getTime();
    if (diff < 60000) return "just now";
    if (diff < 3600000) return Math.round(diff / 60000) + "m ago";
    if (diff < 86400000) return Math.round(diff / 3600000) + "h ago";
    return d.toLocaleDateString();
  } catch (e) {
    return isoStr.slice(0, 10);
  }
}
