(function (window, document) {
  const DEFAULT_CONFIG = {
    apiUrl: "https://api.gokwik.co/kwikship/track/merchant/tracking",
    token:
      "Bearer MDM5ZjcxMzRjYzE1YjMwOWQwOGUzZTE0NGUzMmIwNzM6MThmZDhlNzRiMzlkMTBmYzA3ODgxZmIyOGFiZGQzNGM=",
    collapsedCount: 4,
    mockPayload: null,
  };

  const CHECK_ICON =
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M2.2 6.2 4.7 8.7 9.8 3.3" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const FAIL_ICON =
    '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 3l6 6M9 3L3 9" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/></svg>';

  const CAMERA_ICON =
    '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="4" width="13" height="9.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8.7" r="2.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6 4 6.8 2.6h2.4L10.1 4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function getConfig() {
    return Object.assign({}, DEFAULT_CONFIG, window.TRACK_ORDER_CONFIG || {});
  }

  async function trackOrder(orderId) {
    const config = getConfig();
    const headers = { "Content-Type": "application/json" };

    if (config.token) {
      headers.Authorization = config.token.startsWith("Bearer ")
        ? config.token
        : "Bearer " + config.token;
    }

    const response = await fetch(config.apiUrl, {
      method: "POST",
      headers: headers,
      body: JSON.stringify({ order_id: String(orderId) }),
    });

    if (!response.ok) {
      throw new Error("Tracking API failed: " + response.status);
    }

    return await response.json();
  }

  function formatTimestamp(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";

    const day = new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "Asia/Kolkata",
    }).format(date);

    const time = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone: "Asia/Kolkata",
    }).format(date);

    return day + " • " + time;
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function normalizeStatus(value) {
    return String(value || "")
      .trim()
      .toLowerCase();
  }

  function isFailedStatus(status) {
    return /fail|undelivered|attempted|cancelled|canceled|lost|rto/.test(
      normalizeStatus(status),
    );
  }

  function isDeliveredStatus(status) {
    return normalizeStatus(status) === "delivered";
  }

  function isTerminalStatus(status) {
    return /delivered|cancelled|canceled|lost|rto delivered/.test(
      normalizeStatus(status),
    );
  }

  function pickOrder(payload, orderId) {
    const orders = Array.isArray(payload && payload.orders)
      ? payload.orders
      : [];
    if (!orders.length) return null;

    const wanted = String(orderId || "");
    return (
      orders.find(function (order) {
        return (
          String(order.id) === wanted ||
          String(order.tracking_number) === wanted ||
          String(order.name) === wanted
        );
      }) || orders[0]
    );
  }

  function buildSteps(order) {
    const track = (order && order.tracking_data && order.tracking_data.track) || {};
    const details = Array.isArray(track.details) ? track.details.slice() : [];

    details.sort(function (a, b) {
      return new Date(a.timestamp || 0) - new Date(b.timestamp || 0);
    });

    const currentStatus = track.status || (details[details.length - 1] || {}).status || "";
    const delivered = isDeliveredStatus(currentStatus);

    const steps = details.map(function (item, index) {
      const isLast = index === details.length - 1;
      let state = "done";
      if (isLast && !delivered) state = "current";
      if (isLast && isFailedStatus(item.status || currentStatus)) state = "failed";
      if (delivered && isLast) state = "delivered";

      return {
        status: item.status || "Update",
        desc: item.desc || "",
        location: item.location || "",
        timestamp: item.timestamp || "",
        packingVideo: item.packing_video || item.packingVideo || "",
        state: state,
        locked: false,
      };
    });

    if (!details.length && currentStatus) {
      steps.push({
        status: currentStatus,
        desc: "",
        location: track.location || "",
        timestamp: "",
        packingVideo: "",
        state: isFailedStatus(currentStatus) ? "failed" : delivered ? "delivered" : "current",
        locked: false,
      });
    }

    if (!isTerminalStatus(currentStatus)) {
      steps.push({
        status: "Delivered Status (Locked)",
        desc: "",
        location: "",
        timestamp: "",
        packingVideo: "",
        state: "locked",
        locked: true,
      });
    }

    return { order: order, track: track, steps: steps };
  }

  function stepClass(step) {
    const classes = ["toc-step", "toc-step--" + step.state];
    if (step.locked) classes.push("toc-step--locked");
    return classes.join(" ");
  }

  function stepDot(step) {
    if (step.state === "done" || step.state === "delivered") return CHECK_ICON;
    if (step.state === "failed") return FAIL_ICON;
    return "";
  }

  function renderStep(step, hidden) {
    const time = formatTimestamp(step.timestamp);
    const showDesc =
      step.desc && normalizeStatus(step.desc) !== normalizeStatus(step.status);
    const packingLink = step.packingVideo
      ? '<a class="toc-link is-visible" href="' +
        escapeHtml(step.packingVideo) +
        '" target="_blank" rel="noopener">' +
        CAMERA_ICON +
        "See Packing Video</a>"
      : "";

    const actionButtons =
      step.state === "locked" || step.state === "delivered"
        ? '<div class="toc-actions">' +
          '<button class="toc-btn" type="button" data-toc-action="return"' +
          (step.state === "locked" ? " disabled" : "") +
          ">Return</button>" +
          '<button class="toc-btn" type="button" data-toc-action="exchange"' +
          (step.state === "locked" ? " disabled" : "") +
          ">Exchange</button>" +
          "</div>"
        : "";

    return (
      '<li class="' +
      stepClass(step) +
      (hidden ? " toc-hidden" : "") +
      '">' +
      '<div class="toc-rail" aria-hidden="true"><span class="toc-dot">' +
      stepDot(step) +
      '</span><span class="toc-line"></span></div>' +
      '<div class="toc-body">' +
      '<p class="toc-status">' +
      escapeHtml(step.status) +
      "</p>" +
      (showDesc
        ? '<p class="toc-desc">' + escapeHtml(step.desc) + "</p>"
        : "") +
      (step.location && step.location !== "Unknown"
        ? '<p class="toc-location">' + escapeHtml(step.location) + "</p>"
        : "") +
      (time ? '<p class="toc-meta">' + escapeHtml(time) + "</p>" : "") +
      packingLink +
      actionButtons +
      "</div></li>"
    );
  }

  function renderCard(model, expanded) {
    const config = getConfig();
    const collapseAt = Math.max(1, Number(config.collapsedCount) || 4);
    const hideOlder = !expanded && model.steps.length > collapseAt;
    const startIndex = hideOlder ? model.steps.length - collapseAt : 0;

    const stepsHtml = model.steps
      .map(function (step, index) {
        return renderStep(step, hideOlder && index < startIndex);
      })
      .join("");

    return (
      '<article class="toc-card">' +
      '<h3 class="toc-title">Track Order</h3>' +
      '<ol class="toc-timeline">' +
      stepsHtml +
      "</ol>" +
      '<button class="toc-see-all" type="button">' +
      (expanded ? "Show Less" : "See All Updates") +
      "</button>" +
      "</article>"
    );
  }

  function bindCard(container, model) {
    const seeAll = container.querySelector(".toc-see-all");
    if (seeAll) {
      seeAll.addEventListener("click", function () {
        const next = !container.classList.contains("is-expanded");
        renderTrackOrder(container, container._tocPayload, {
          expanded: next,
          orderId: container._tocOrderId,
        });
      });
    }

    container.querySelectorAll("[data-toc-action]").forEach(function (button) {
      button.addEventListener("click", function () {
        if (button.disabled) return;
        container.dispatchEvent(
          new CustomEvent("track-order:" + button.getAttribute("data-toc-action"), {
            bubbles: true,
            detail: {
              orderId: container._tocOrderId,
              order: model.order,
            },
          }),
        );
      });
    });
  }

  function renderTrackOrder(container, payload, options) {
    options = options || {};
    const orderId =
      options.orderId ||
      container.getAttribute("order-id") ||
      container.getAttribute("data-order-id") ||
      "";
    const order = pickOrder(payload, orderId);

    container._tocPayload = payload;
    container._tocOrderId = orderId;
    container.classList.toggle("is-expanded", !!options.expanded);

    if (!order) {
      container.innerHTML =
        '<article class="toc-card"><div class="toc-state"><strong>No tracking found</strong>We could not find updates for this order.</div></article>';
      return;
    }

    const model = buildSteps(order);
    container.innerHTML = renderCard(model, !!options.expanded);
    bindCard(container, model);
  }

  function renderLoading(container) {
    container.innerHTML =
      '<article class="toc-card toc-skeleton">' +
      '<h3 class="toc-title">Track Order</h3>' +
      '<ol class="toc-timeline">' +
      [1, 2, 3, 4]
        .map(function () {
          return (
            '<li class="toc-step toc-step--pending">' +
            '<div class="toc-rail"><span class="toc-dot"></span><span class="toc-line"></span></div>' +
            '<div class="toc-body"><p class="toc-status">Loading</p><p class="toc-meta">Loading</p></div>' +
            "</li>"
          );
        })
        .join("") +
      "</ol></article>";
  }

  function renderError(container, message) {
    container.innerHTML =
      '<article class="toc-card"><div class="toc-state"><strong>Unable to load tracking</strong>' +
      escapeHtml(message || "Please try again.") +
      '<div><button class="toc-retry" type="button">Retry</button></div></div></article>';

    const retry = container.querySelector(".toc-retry");
    if (retry) retry.addEventListener("click", function () {
      mountTrackOrder(container);
    });
  }

  async function mountTrackOrder(container) {
    const orderId =
      container.getAttribute("order-id") ||
      container.getAttribute("data-order-id") ||
      "";

    if (!orderId) {
      renderError(container, "Missing order-id on this block.");
      return;
    }

    renderLoading(container);

    try {
      const payload = await trackOrder(orderId);
      renderTrackOrder(container, payload, { orderId: orderId, expanded: false });
    } catch (error) {
      const mockPayload = getConfig().mockPayload;
      if (mockPayload) {
        renderTrackOrder(container, mockPayload, {
          orderId: orderId,
          expanded: false,
        });
        return;
      }
      renderError(container, error.message);
    }
  }

  function initTrackOrder(root) {
    const scope = root && root.querySelectorAll ? root : document;
    const nodes = scope.querySelectorAll
      ? scope.querySelectorAll(".track-order-container")
      : [];

    nodes.forEach(function (container) {
      if (container === scope && !container.classList.contains("track-order-container")) {
        return;
      }
      mountTrackOrder(container);
    });

    if (scope.classList && scope.classList.contains("track-order-container")) {
      mountTrackOrder(scope);
    }
  }

  window.trackOrder = trackOrder;
  window.renderTrackOrder = renderTrackOrder;
  window.initTrackOrder = initTrackOrder;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      initTrackOrder(document);
    });
  } else {
    initTrackOrder(document);
  }
})(window, document);
