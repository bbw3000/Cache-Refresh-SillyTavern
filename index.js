/**
 * Cache Refresher Extension for SillyTavern
 *
 * This extension automatically keeps the language model's cache "warm" by sending
 * periodic minimal requests, then truncating streamed responses early to reduce API costs.
 */

import { extension_settings } from '../../../extensions.js';
const { chatCompletionSettings, eventSource, eventTypes, renderExtensionTemplateAsync, getRequestHeaders, saveSettingsDebounced } = SillyTavern.getContext();

// Log extension loading attempt
console.log('Cache Refresher: Loading extension...');

// Extension name and path
const extensionName = 'Cache-Refresh-SillyTavern';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;
const path = `third-party/${extensionName}`;

// Default configuration
const defaultSettings = {
    enabled: false,
    refreshInterval: (5 * 60 - 30) * 1000, // 4 minutes 30 seconds in milliseconds (optimized for typical cache lifetimes)
    maxRefreshes: 3,                       // Maximum number of refresh requests to send before stopping
    maxTokens: 1,                          // Maximum tokens to request for cache refresh (keeping it minimal to reduce costs)
    showNotifications: true,               // Whether to display toast notifications for each refresh
    showStatusIndicator: true,             // Whether to display the floating status indicator
    disableMaxTokens: false,               // Whether to disable the max tokens feature (enable for problematic providers)
    truncateStream: true,                  // Whether to cut off the streaming refresh request early
    statusWidgetPosition: null,           // Persisted floating widget position
    refreshMessage: 'STOP roleplay.\nNow you must simply reply "API OK".\nOverthinking or reasoning is banned to prevent wasting tokens.',
};

// Initialize extension settings
if (!extension_settings[extensionName]) {
    extension_settings[extensionName] = {};
    console.log('Cache Refresher: Creating new settings object');
}

// Merge with defaults - preserves user settings while ensuring all required properties exist
extension_settings[extensionName] = Object.assign({}, defaultSettings, extension_settings[extensionName]);
const settings = extension_settings[extensionName];
console.log('Cache Refresher: Settings initialized', settings);

// State variables
let lastGenerationData = {
    prompt: null,                // Stores the last prompt sent to the AI model
};
let refreshTimer = null;         // Timer for scheduling the next refresh
let refreshesLeft = 0;           // Counter for remaining refreshes in the current cycle
let refreshInProgress = false;   // Flag to prevent concurrent refreshes
let statusIndicator = null;      // DOM element for the floating status indicator
let nextRefreshTime = null;      // Timestamp for the next scheduled refresh
let statusUpdateInterval = null; // Interval for updating the countdown timer
let statusDragState = null;      // Pointer drag state for the floating widget

function cloneChatData(chat) {
    if (typeof structuredClone === 'function') {
        return structuredClone(chat);
    }

    return JSON.parse(JSON.stringify(chat));
}

function saveStatusWidgetPosition(left, top) {
    settings.statusWidgetPosition = { left, top };
    void saveSettings();
}

function applyStatusWidgetPosition() {
    if (!statusIndicator) return;

    const pos = settings.statusWidgetPosition;
    if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        statusIndicator.style.left = `${Math.round(pos.left)}px`;
        statusIndicator.style.top = `${Math.round(pos.top)}px`;
        statusIndicator.style.right = 'auto';
        statusIndicator.style.bottom = 'auto';
    } else {
        statusIndicator.style.left = 'auto';
        statusIndicator.style.top = 'auto';
        statusIndicator.style.right = '10px';
        statusIndicator.style.bottom = '10px';
    }
}

function setStatusWidgetTheme(mode) {
    if (!statusIndicator) return;
    statusIndicator.dataset.state = mode;
}

function getCountdownParts(intervalMs) {
    const safeMs = Math.max(0, Number(intervalMs) || 0);
    const minutes = Math.floor(safeMs / 60000);
    const seconds = Math.floor((safeMs % 60000) / 1000);
    return { minutes, seconds };
}

function bindStatusWidgetEvents() {
    if (!statusIndicator || statusIndicator.dataset.bound === '1') return;

    const switchBtn = statusIndicator.querySelector('.cache_refresher_switch');

    switchBtn?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        $('#cache_refresher_enabled').prop('checked', !settings.enabled).trigger('change');
    });

    statusIndicator.addEventListener('pointerdown', (event) => {
        if (event.target.closest('.cache_refresher_switch') || event.target.closest('button,input,label,a,textarea,select')) {
            return;
        }

        const rect = statusIndicator.getBoundingClientRect();
        statusIndicator.style.width = `${Math.round(rect.width)}px`;
        statusDragState = {
            pointerId: event.pointerId,
            offsetX: event.clientX - rect.left,
            offsetY: event.clientY - rect.top,
        };

        statusIndicator.classList.add('is-dragging');
        statusIndicator.setPointerCapture?.(event.pointerId);
        event.preventDefault();
    });

    statusIndicator.addEventListener('pointermove', (event) => {
        if (!statusDragState || statusDragState.pointerId !== event.pointerId) return;

        const width = statusIndicator.offsetWidth || 260;
        const height = statusIndicator.offsetHeight || 52;
        const left = Math.max(0, Math.min(window.innerWidth - width, event.clientX - statusDragState.offsetX));
        const top = Math.max(0, Math.min(window.innerHeight - height, event.clientY - statusDragState.offsetY));

        statusIndicator.style.left = `${Math.round(left)}px`;
        statusIndicator.style.top = `${Math.round(top)}px`;
        statusIndicator.style.right = 'auto';
        statusIndicator.style.bottom = 'auto';
    });

    const endDrag = (event) => {
        if (!statusDragState || statusDragState.pointerId !== event.pointerId) return;
        statusDragState = null;
        statusIndicator.classList.remove('is-dragging');
        const left = parseFloat(statusIndicator.style.left || '0') || 0;
        const top = parseFloat(statusIndicator.style.top || '0') || 0;
        saveStatusWidgetPosition(left, top);
        statusIndicator.style.width = '';
    };

    statusIndicator.addEventListener('pointerup', endDrag);
    statusIndicator.addEventListener('pointercancel', endDrag);

    statusIndicator.dataset.bound = '1';
}

const supportedChatCompletionSources = new Set(['openai', 'custom', 'claude', 'makersuite']);

function getCurrentChatCompletionSource() {
    const source = String(chatCompletionSettings?.chat_completion_source || 'openai');
    return supportedChatCompletionSources.has(source) ? source : null;
}

function getCurrentChatCompletionModel(source = getCurrentChatCompletionSource()) {
    switch (source) {
        case 'claude':
            return chatCompletionSettings?.claude_model || '';
        case 'makersuite':
            return chatCompletionSettings?.google_model || '';
        case 'custom':
            return chatCompletionSettings?.custom_model || '';
        case 'openai':
            return chatCompletionSettings?.openai_model || '';
        default:
            return '';
    }
}

function buildRefreshMessages() {
    const prompt = cloneChatData(lastGenerationData.prompt);
    const refreshMessage = (settings.refreshMessage || defaultSettings.refreshMessage).trim();

    if (!Array.isArray(prompt) || !prompt.length) {
        return [{ role: 'user', content: refreshMessage }];
    }

    const lastIndex = prompt.length - 1;
    const lastMessage = prompt[lastIndex];

    if (lastMessage && typeof lastMessage === 'object') {
        const updatedMessage = { ...lastMessage };
        if ('content' in updatedMessage) updatedMessage.content = refreshMessage;
        if ('mes' in updatedMessage) updatedMessage.mes = refreshMessage;
        if ('text' in updatedMessage) updatedMessage.text = refreshMessage;
        if ('message' in updatedMessage) updatedMessage.message = refreshMessage;
        prompt[lastIndex] = updatedMessage;
    } else {
        prompt[lastIndex] = { role: 'user', content: refreshMessage };
    }

    return prompt;
}

function buildRefreshRequestBody(stream) {
    const source = getCurrentChatCompletionSource();
    const model = getCurrentChatCompletionModel(source);

    if (!source || !model) {
        throw new Error(`Unsupported chat completion source: ${chatCompletionSettings?.chat_completion_source || 'unknown'}`);
    }

    const maxTokens = settings.disableMaxTokens
        ? Number(chatCompletionSettings?.openai_max_tokens || settings.maxTokens || 1)
        : Number(settings.maxTokens || 1);

    const body = {
        chat_completion_source: source,
        model,
        messages: buildRefreshMessages(),
        stream: !!stream,
        max_tokens: maxTokens,
        max_completion_tokens: maxTokens,
        temperature: Number(chatCompletionSettings?.temp_openai ?? 1),
        top_p: Number(chatCompletionSettings?.top_p_openai ?? 1),
        presence_penalty: Number(chatCompletionSettings?.pres_pen_openai ?? 0),
        frequency_penalty: Number(chatCompletionSettings?.freq_pen_openai ?? 0),
    };

    if (source === 'openai' || source === 'claude' || source === 'makersuite') {
        body.reverse_proxy = String(chatCompletionSettings?.reverse_proxy || '');
        body.proxy_password = String(chatCompletionSettings?.proxy_password || '');
    }

    if (source === 'custom') {
        body.custom_url = String(chatCompletionSettings?.custom_url || '');
        body.custom_include_body = String(chatCompletionSettings?.custom_include_body || '');
        body.custom_exclude_body = String(chatCompletionSettings?.custom_exclude_body || '');
        body.custom_include_headers = String(chatCompletionSettings?.custom_include_headers || '');
    }

    if (source === 'claude') {
        body.use_sysprompt = Boolean(chatCompletionSettings?.use_sysprompt);
    }

    return body;
}

async function postRefreshRequest(body, signal) {
    return await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        cache: 'no-cache',
        body: JSON.stringify(body),
        signal,
    });
}

async function consumeResponseBody(response, controller, truncateStream) {
    if (!response.body) {
        return false;
    }

    const reader = response.body.getReader();

    try {
        if (truncateStream) {
            const { done } = await reader.read();
            if (!done) {
                controller.abort();
                return true;
            }
            return false;
        }

        while (true) {
            const { done } = await reader.read();
            if (done) break;
        }
    } finally {
        try {
            await reader.cancel();
        } catch (error) {
            debugLog('Stream reader cancel failed', error);
        }
    }

    return false;
}

/**
 * Logs a message to console with extension prefix for easier debugging
 * @param {string} message - Message to log
 * @param {any} data - Optional data to log
 */
function debugLog(message, data) {
    console.log(`[Cache Refresher] ${message}`, data || '');
}

/**
 * Shows a notification if notifications are enabled in settings
 * @param {string} message - Message to show
 * @param {string} type - Notification type (success, info, warning, error)
 */
function showNotification(message, type = 'info') {
    if (settings.showNotifications) {
        toastr[type](message, '', { timeOut: 3000 });
    }
}

/**
 * Check if the current API is using chat completion format
 * @returns {boolean} True if using a chat completion API
 */
function isChatCompletion() {
    return supportedChatCompletionSources.has(String(chatCompletionSettings?.chat_completion_source || 'openai'));
}

/**
 * Updates the extension settings in localStorage via SillyTavern's extension_settings
 * This ensures settings persist between sessions
 */
async function saveSettings() {
    try {
        extension_settings[extensionName] = settings;
        await saveSettingsDebounced();
        debugLog('Settings saved', settings);
    } catch (error) {
        console.error('Cache Refresher: Error saving settings:', error);
        showNotification('Error saving settings', 'error');
    }
}

/**
 * Updates all UI elements to reflect current state
 * This is called whenever the extension state changes
 */
function updateUI() {
    // Update both the floating status indicator and the settings panel
    updateStatusIndicator();
    updateSettingsPanel();
}

/**
 * Creates or updates the floating status indicator
 * This shows the number of remaining refreshes and countdown timer
 */
function updateStatusIndicator() {
    // Create the status indicator if it doesn't exist
    if (!statusIndicator) {
        statusIndicator = document.createElement('div');
        statusIndicator.id = 'cache_refresher_status';
        statusIndicator.className = 'cache_refresher_status_widget';
        statusIndicator.innerHTML = `
            <div class="cache_refresher_status_header">
                <button type="button" class="cache_refresher_switch" aria-label="Toggle Cache Refresher" aria-pressed="false">
                    <span class="cache_refresher_switch_track"><span class="cache_refresher_switch_thumb"></span></span>
                </button>
                <div class="cache_refresher_status_title"></div>
            </div>
            <div class="cache_refresher_status_separator"></div>
            <div class="cache_refresher_status_controls">
                <div class="cache_refresher_count_block">
                    <div class="cache_refresher_display_number">
                        <span class="cache_refresher_count_value"></span>
                        <span class="cache_refresher_count_suffix">TIMES</span>
                    </div>
                </div>
                <span class="cache_refresher_control_divider">|</span>
                <div class="cache_refresher_time_block">
                    <div class="cache_refresher_display_time"><span class="cache_refresher_time_value"></span></div>
                </div>
            </div>
        `;
        document.body.appendChild(statusIndicator);
        bindStatusWidgetEvents();
        applyStatusWidgetPosition();
    }

    // Show the indicator whenever the widget is enabled in settings
    if (settings.showStatusIndicator) {
        const countdownParts = getCountdownParts(nextRefreshTime ? Math.max(0, nextRefreshTime - Date.now()) : settings.refreshInterval);

        if (nextRefreshTime) {
            // Calculate time until next refresh
            const timeRemaining = Math.max(0, nextRefreshTime - Date.now());

            // Format time as MM:SS
            void timeRemaining;
        }

        const titleEl = statusIndicator.querySelector('.cache_refresher_status_title');
        const countValueEl = statusIndicator.querySelector('.cache_refresher_count_value');
        const timeValueEl = statusIndicator.querySelector('.cache_refresher_time_value');
        const switchBtn = statusIndicator.querySelector('.cache_refresher_switch');

        if (switchBtn) {
            switchBtn.setAttribute('aria-pressed', String(settings.enabled));
        }

        const text = settings.enabled ? 'Cache Refresher enabled' : 'Cache Refresher disabled';
        const theme = !settings.enabled ? 'disabled' : (refreshInProgress || (refreshesLeft > 0 && nextRefreshTime) ? 'active' : 'idle');

        if (titleEl) {
            titleEl.textContent = text;
        }

        if (countValueEl) {
            countValueEl.textContent = String(Math.max(0, refreshesLeft)).padStart(2, '0');
        }

        if (timeValueEl) {
            const timeDisplay = String(countdownParts.minutes).padStart(2, '0') + ':' + String(countdownParts.seconds).padStart(2, '0');
            timeValueEl.textContent = timeDisplay;
        }

        setStatusWidgetTheme(theme);
        statusIndicator.style.display = 'flex';

        // Update the timer display every second for a smooth countdown
        if (!statusUpdateInterval) {
            statusUpdateInterval = setInterval(() => {
                updateStatusIndicator();
            }, 1000);
        }
    } else {
        // Hide the indicator when not active
        statusIndicator.style.display = 'none';

        // Clear the update interval when not needed to save resources
        if (statusUpdateInterval) {
            clearInterval(statusUpdateInterval);
            statusUpdateInterval = null;
        }
    }
}

/**
 * Updates the HTML settings panel with current values
 * This ensures the UI always reflects the actual state of the extension
 */
async function updateSettingsPanel() {
    try {
        // Update checkbox states to match current settings
        $('#cache_refresher_enabled').prop('checked', settings.enabled);
        $('#cache_refresher_show_notifications').prop('checked', settings.showNotifications);
        $('#cache_refresher_show_status_indicator').prop('checked', settings.showStatusIndicator);
        $('#cache_refresher_disable_max_tokens').prop('checked', settings.disableMaxTokens);
        $('#cache_refresher_truncate_stream').prop('checked', settings.truncateStream);

        // Update number inputs with current values
        // Convert milliseconds to minutes for the interval display
        $('#cache_refresher_max_refreshes').val(settings.maxRefreshes);
        $('#cache_refresher_interval').val(settings.refreshInterval / (60 * 1000));
        $('#cache_refresher_max_tokens').val(settings.maxTokens);
        $('#cache_refresher_refresh_message').val(settings.refreshMessage);

        // Enable/disable the max tokens input based on the disableMaxTokens setting
        $('#cache_refresher_max_tokens').prop('disabled', settings.disableMaxTokens);

        // Update the status text to show current state
        const statusText = $('#cache_refresher_status_text');
        if (statusText.length) {
            if (settings.enabled) {
                if (refreshInProgress) {
                    statusText.text('Refreshing cache...');
                } else if (refreshesLeft > 0) {
                    statusText.text(`Active - ${refreshesLeft} refreshes remaining`);
                } else {
                    statusText.text('Active - waiting for next generation');
                }
            } else {
                statusText.text('Inactive');
            }
        }

        debugLog('Settings panel updated');
    } catch (error) {
        console.error('Cache Refresher: Error updating settings panel:', error);
    }
}

/**
 * Binds event handlers to the settings panel elements
 * This sets up all the interactive controls in the settings panel
 */
async function bindSettingsHandlers() {
    try {
        debugLog('Binding settings handlers');

        // Enable/disable toggle - main switch for the extension
        $('#cache_refresher_enabled').off('change').on('change', async function() {
            settings.enabled = $(this).prop('checked');
            await saveSettings();

            if (settings.enabled) {
                showNotification('Cache refreshing enabled');
                // Don't start refresh cycle here, wait for a message
                // This prevents unnecessary refreshes when no conversation is active
            } else {
                showNotification('Cache refreshing disabled');
                stopRefreshCycle(); // Stop any active refresh cycle
                // Clear any stored generation data to prevent future refreshes
                lastGenerationData.prompt = null;
                refreshesLeft = 0;
            }

            updateUI();
            updateSettingsPanel();
        });

        // Show notifications toggle - controls whether to show toast notifications
        $('#cache_refresher_show_notifications').off('change').on('change', async function() {
            settings.showNotifications = $(this).prop('checked');
            await saveSettings();
        });
        
        // Show status indicator toggle - controls whether to show the floating status indicator
        $('#cache_refresher_show_status_indicator').off('change').on('change', async function() {
            settings.showStatusIndicator = $(this).prop('checked');

            if (!settings.showStatusIndicator) {
                settings.enabled = false;
                stopRefreshCycle();
                lastGenerationData.prompt = null;
                refreshesLeft = 0;
            }

            await saveSettings();
            updateSettingsPanel();
            updateUI(); // Update UI immediately to show/hide the indicator
        });

        // Disable max tokens toggle - controls whether to disable the max tokens feature
        $('#cache_refresher_disable_max_tokens').off('change').on('change', async function() {
            settings.disableMaxTokens = $(this).prop('checked');
            await saveSettings();
            updateSettingsPanel(); // Update UI to enable/disable the max tokens input
        });

        // Truncate stream toggle - stops streamed responses shortly after they start
        $('#cache_refresher_truncate_stream').off('change').on('change', async function() {
            settings.truncateStream = $(this).prop('checked');
            await saveSettings();
        });

        // Max refreshes input - controls how many refreshes to perform before stopping
        $('#cache_refresher_max_refreshes').off('change input').on('change input', async function() {
            settings.maxRefreshes = parseInt($(this).val()) || defaultSettings.maxRefreshes;
            await saveSettings();

            // If a refresh cycle is already running, stop and reschedule with new settings
            if (settings.enabled && refreshTimer) {
                stopRefreshCycle();
                scheduleNextRefresh();
            }
        });

        // Refresh interval input - controls time between refreshes (in minutes)
        $('#cache_refresher_interval').off('change input').on('change input', async function() {
            // Convert minutes to milliseconds for internal use
            settings.refreshInterval = (parseFloat($(this).val()) || defaultSettings.refreshInterval / (60 * 1000)) * 60 * 1000;
            await saveSettings();

            // If a refresh cycle is already running, stop and reschedule with new settings
            if (settings.enabled && refreshTimer) {
                stopRefreshCycle();
                scheduleNextRefresh();
            }
        });

        // Max tokens input - controls how many tokens to request in each refresh
        $('#cache_refresher_max_tokens').off('change input').on('change input', async function() {
            settings.maxTokens = parseInt($(this).val()) || defaultSettings.maxTokens;
            await saveSettings();
        });

        // Refresh message input - controls the fallback message used for cache refreshes
        $('#cache_refresher_refresh_message').off('change input').on('change input', async function() {
            settings.refreshMessage = $(this).val() || defaultSettings.refreshMessage;
            await saveSettings();
        });

        debugLog('Settings handlers bound successfully');
    } catch (error) {
        console.error('Cache Refresher: Error binding settings handlers:', error);
    }
}

/**
 * Adds the extension buttons to the UI
 * Currently just initializes the UI state
 */
async function addExtensionControls() {
    // No need to add buttons - the extension will be controlled through the settings panel
    updateUI();
}

/**
 * !!!DEPRECATED!!!
 * Starts the refresh cycle
 * This should only be called internally and not directly from event handlers
 * It begins the process of periodically refreshing the cache
 */
function startRefreshCycle() {
    debugLog('startRefreshCycle:', lastGenerationData);

    // Don't start if we don't have a prompt or if the extension is disabled
    if (!lastGenerationData.prompt || !settings.enabled) return;
    debugLog('startRefreshCycle: pass');

    // Only support chat completion APIs for now
    if (!isChatCompletion()) {
        debugLog('startRefreshCycle: Not a chat completion prompt');
        return;
    }

    // Clear any existing cycle to prevent duplicates
    stopRefreshCycle();

    // Initialize the refresh cycle
    refreshesLeft = settings.maxRefreshes;
    scheduleNextRefresh();
    updateUI();

    debugLog('Refresh cycle started', {
        refreshesLeft,
        interval: settings.refreshInterval,
    });
}

/**
 * Stops the refresh cycle
 * Cleans up all timers and resets state
 */
function stopRefreshCycle() {
    // Clear the refresh timer
    if (refreshTimer) {
        clearTimeout(refreshTimer);
        refreshTimer = null;
    }

    // Clear the status update interval
    if (statusUpdateInterval) {
        clearInterval(statusUpdateInterval);
        statusUpdateInterval = null;
    }

    // Reset state variables
    nextRefreshTime = null;
    refreshInProgress = false;

    // Update UI to reflect stopped state
    updateUI();

    debugLog('Refresh cycle stopped');
}

/**
 * Schedules the next refresh
 * This sets up a timer to perform the next cache refresh
 */
function scheduleNextRefresh() {
    // Don't schedule if the extension is disabled, no refreshes left, or no prompt
    if (!settings.enabled || refreshesLeft <= 0 || !lastGenerationData.prompt) {
        stopRefreshCycle();
        return;
    }

    // Calculate and store the next refresh time for the countdown display
    nextRefreshTime = Date.now() + settings.refreshInterval;

    // Set up the timer for the next refresh
    refreshTimer = setTimeout(() => {
        refreshCache();
    }, settings.refreshInterval);

    debugLog(`Next refresh scheduled in ${settings.refreshInterval / 1000} seconds`);

    // Update the status indicator immediately to show new time
    updateStatusIndicator();
}

/**
 * Performs a cache refresh by sending a minimal request to the API
 * This keeps the model's context cache warm without generating a full response
 */
async function refreshCache() {
    // Don't refresh if we don't have a prompt or if a refresh is already in progress
    if (!lastGenerationData.prompt || refreshInProgress) return;

    // Set the flag to prevent concurrent refreshes
    refreshInProgress = true;
    updateUI();

    let refreshNotice = null;
    let refreshNoticeType = 'info';
    
    try {
        debugLog('Refreshing cache with data', lastGenerationData);

        // Verify we're using a supported API
        if (!isChatCompletion()) {
            throw new Error(`Unsupported chat completion source for cache refresh: ${chatCompletionSettings?.chat_completion_source || 'unknown'}`);
        }

        const requestBody = buildRefreshRequestBody(true);
        const controller = new AbortController();
        const response = await postRefreshRequest(requestBody, controller.signal);

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}${errText ? `: ${errText}` : ''}`);
        }

        let streamTruncated = false;
        if (settings.truncateStream) {
            streamTruncated = await consumeResponseBody(response, controller, true);
        } else {
            await response.text().catch(() => '');
        }

        if (settings.truncateStream && (streamTruncated || controller.signal.aborted)) {
            refreshNotice = 'Received stream response and truncated, cache has been refreshed.';
            refreshNoticeType = 'info';
        } else {
            refreshNotice = `Cache refreshed. ${refreshesLeft - 1} refreshes remaining.`;
            refreshNoticeType = 'success';
        }

    } catch (error) {
        if (error?.name === 'AbortError' || /abort/i.test(error?.message || '')) {
            refreshNotice = 'Received stream response and truncated, cache has been refreshed.';
            refreshNoticeType = 'info';
            debugLog('Cache refresh truncated as expected', error);
        } else {
            debugLog('Cache refresh failed', error);
            refreshNotice = `Cache refresh failed: ${error.message}`;
            refreshNoticeType = 'error';
        }
    } finally {
        // Always clean up, even if there was an error
        refreshInProgress = false;
        refreshesLeft--;
        updateUI();
        scheduleNextRefresh(); // Schedule the next refresh (or stop if no refreshes left)

        if (refreshNotice) {
            showNotification(refreshNotice, refreshNoticeType);
        }
    }
}

/**
 * Captures generation data for future cache refreshing
 * This is called when a new message is generated to store the prompt for later refreshes
 *
 * @param {Object} data - The generation data from SillyTavern; looks like this '{chat: Array(17), dryRun: true}'
 */
function captureGenerationData(data) {
    // Don't capture if the extension is disabled
    if (!settings.enabled) {
        // Ensure we don't have any stored data if disabled
        if (lastGenerationData.prompt) {
            lastGenerationData.prompt = null;
            debugLog('Extension disabled - cleared stored generation data');
        }
        return;
    }

    debugLog('captureGenerationData', data);
    debugLog('Current source:', chatCompletionSettings?.chat_completion_source);

    try {
        // Only support chat completion APIs for now
        if (!isChatCompletion()) {
            debugLog('Cache Refresher: Not a chat completion prompt');
            return;
        }

        // Skip dry runs as they're not actual messages
        // Dry runs are used for things like token counting and don't represent actual chat messages
        if (data.dryRun) {
            debugLog('Cache Refresher: Skipping dry run');
            return;
        }

        // Store the chat prompt for future refreshes
        lastGenerationData.prompt = cloneChatData(data.chat);
        debugLog('Captured generation data', lastGenerationData);
        //Stop refresh cycle on new prompt (work better than GENERATION_STOPPED event)
        stopRefreshCycle();

    } catch (error) {
        debugLog('Error capturing generation data', error);
    }
}

/**
 * Loads the extension CSS
 * This adds the extension's stylesheet to the page
 */
function loadCSS() {
    try {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.type = 'text/css';
        link.href = `/${extensionFolderPath}/styles.css`;
        document.head.appendChild(link);
        console.log('Cache Refresher: CSS loaded');
        debugLog('CSS loaded');
    } catch (error) {
        console.error('Cache Refresher: Error loading CSS:', error);
    }
}


// Initialize the extension when jQuery is ready
jQuery(async ($) => {
    try {
        debugLog('Starting initialization');

        // Append the settings HTML to the extensions settings panel
        // This loads the HTML template from cache-refresher.html
        $('#extensions_settings').append(await renderExtensionTemplateAsync(path, 'cache-refresher'));

        // Load CSS and set up UI
        loadCSS();
        addExtensionControls();

        // Initialize the settings panel with current values
        updateSettingsPanel();

        // Bind event handlers for all interactive elements
        bindSettingsHandlers();

        // Set up event listeners for SillyTavern events

        // Listen for chat completion prompts to capture them for refreshing
        eventSource.on(eventTypes.APP_READY, () => {
            eventSource.on(eventTypes.CHAT_COMPLETION_PROMPT_READY, captureGenerationData);
        });

        // Listen for new messages to start the refresh cycle
        // Only start the refresh cycle when a message is received to avoid unnecessary refreshes
        eventSource.on(eventTypes.APP_READY, () => {
            eventSource.on(eventTypes.MESSAGE_RECEIVED, () => {
                if (settings.enabled && lastGenerationData.prompt) {
                    debugLog('Message received, starting refresh cycle');
                    stopRefreshCycle(); // Clear any existing cycle first
                    refreshesLeft = settings.maxRefreshes;
                    scheduleNextRefresh();
                    updateUI();
                }
            });
            
            // Listen for chat changes to stop the refresh cycle
            // When user switches to a different chat, we don't need to refresh the previous chat anymore
            eventSource.on(eventTypes.CHAT_CHANGED, () => {
                debugLog('Chat changed, stopping refresh cycle');
                stopRefreshCycle();
                lastGenerationData.prompt = null; // Clear the stored prompt
                refreshesLeft = 0;
                updateUI();
            });
        });

        // Make sure we start with clean state if disabled
        if (!settings.enabled) {
            lastGenerationData.prompt = null;
            refreshesLeft = 0;
            debugLog('Extension disabled at startup - ensuring clean state');
        }

        debugLog('Extension initialized');
        console.log(`[${extensionName}] Extension initialized successfully`);
    } catch (error) {
        console.error(`[${extensionName}] Error initializing extension:`, error);
    }
});
