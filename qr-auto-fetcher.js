
// Global variables
let ws = null;
let connectionId = null;
let messageId = 1;
let userData = null;
let qrTokenData = null;
let generator = null;
let updateInterval = null;
let countdownInterval = null;
let qrCodeInstance = null;

class QRGenerator {
    constructor(gestixiId, hashedToken, magicKey = 'paH3tGeqmugkUT5Ls', intervalSec = 10) {
        this.gestixiId = gestixiId;
        this.hashedToken = hashedToken;
        this.magicKey = magicKey;
        this.intervalSec = intervalSec;
        this.intervalMs = intervalSec * 1000;
    }
    
    computeTimeBucket(timestamp = Date.now()) {
        const bucket = Math.floor(timestamp / this.intervalMs);
        const nextRefreshSec = (bucket * this.intervalSec) + this.intervalSec;
        const remainingMs = (nextRefreshSec * 1000) - timestamp;
        
        // Don't log every time calculation
        
        return {
            bucket: nextRefreshSec,
            remainingMs: remainingMs,
            bucketTimestamp: bucket * this.intervalMs
        };
    }
    
    generateQRCode(mode = 'current', timestamp = Date.now()) {
        let adjustedTimestamp = timestamp;
        if (mode !== 'current') {
            adjustedTimestamp += this.intervalMs;
        }
        
        const timeInfo = this.computeTimeBucket(adjustedTimestamp);
        const hashInput = this.magicKey + this.hashedToken + timeInfo.bucket + this.magicKey;
        const hash = sha256(hashInput);
        const qrCode = `${this.gestixiId}-${hash}-arkose+`;
        
        // Only log on first generation or significant changes
        if (!this.lastLoggedBucket || this.lastLoggedBucket !== timeInfo.bucket) {
            this.lastLoggedBucket = timeInfo.bucket;
            logMessage(`New QR generated for time bucket ${timeInfo.bucket}: ${qrCode.substring(0, 50)}...`, 'qr');
        }
        
        return {
            qrCode: qrCode,
            remainingMs: timeInfo.remainingMs,
            timeBucket: timeInfo.bucket,
            hashInput: hashInput,
            hash: hash,
            validUntil: new Date(timestamp + timeInfo.remainingMs),
            generatedAt: new Date(timestamp)
        };
    }
}

/**
 * Connect to WebSocket and fetch data
 */
function connectAndFetch() {
    const authToken = document.getElementById('authToken').value.trim();
    const wsUrl = document.getElementById('wsUrl').value.trim();
    
    if (!authToken) {
        alert('Please enter an auth token');
        return;
    }
    
    updateStatus('Connecting to ' + wsUrl + '...', 'info');
    
    // Reset message ID counter
    messageId = 1;
    
    try {
        // Create WebSocket connection
        ws = new WebSocket(wsUrl);
        
        ws.onopen = () => {
            updateStatus('WebSocket connected, initializing DDP...', 'success');
            logMessage('WebSocket opened', 'info');
            
            // Send DDP connect message
            sendMessage({
                msg: 'connect',
                version: '1',
                support: ['1', 'pre2', 'pre1']
            });
        };
        
        ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                logMessage('Received: ' + JSON.stringify(data, null, 2), 'received');
                handleMessage(data, authToken);
            } catch (e) {
                logMessage('Failed to parse message: ' + e.message, 'error');
            }
        };
        
        ws.onerror = (error) => {
            updateStatus('WebSocket error: ' + error, 'error');
            logMessage('WebSocket error: ' + JSON.stringify(error), 'error');
        };
        
        ws.onclose = () => {
            updateStatus('WebSocket connection closed', 'warning');
            logMessage('WebSocket closed', 'warning');
            ws = null;
            connectionId = null;
        };
        
        // Update UI
        document.getElementById('connectBtn').style.display = 'none';
        // Don't show disconnect button - will auto-disconnect
        document.getElementById('authToken').disabled = true;
        document.getElementById('wsUrl').disabled = true;
        
    } catch (error) {
        updateStatus('Failed to connect: ' + error.message, 'error');
        logMessage('Connection error: ' + error.message, 'error');
    }
}

/**
 * Handle incoming WebSocket messages
 */
function handleMessage(data, authToken) {
    switch (data.msg) {
        case 'connected':
            connectionId = data.session;
            updateStatus('DDP connected, session: ' + connectionId, 'success');
            
            // Try to login with token
            loginWithToken(authToken);
            break;
            
        case 'result':
            handleResult(data);
            break;
            
        case 'added':
            if (data.collection === 'users') {
                handleUserData(data.fields);
            }
            break;
            
        case 'changed':
            if (data.collection === 'users') {
                handleUserData(data.fields);
            }
            break;
            
        case 'error':
            updateStatus('Error: ' + JSON.stringify(data.error), 'error');
            logMessage('Error: ' + JSON.stringify(data.error), 'error');
            break;
            
        case 'ping':
            sendMessage({ msg: 'pong', id: data.id });
            break;
    }
}

/**
 * Try different login methods
 */
function loginWithToken(token) {
    updateStatus('Attempting login with token...', 'info');
    
    // Method 1: Login with resume token
    sendMessage({
        msg: 'method',
        method: 'login',
        params: [{ resume: token }],
        id: String(messageId++)
    });
    
    // Also try as a regular token
    setTimeout(() => {
        sendMessage({
            msg: 'method',
            method: 'login',
            params: [{ token: token }],
            id: String(messageId++)
        });
    }, 1000);
    
    // Try _loginWithToken method
    setTimeout(() => {
        sendMessage({
            msg: 'method',
            method: '_loginWithToken',
            params: [token],
            id: String(messageId++)
        });
    }, 2000);
}

/**
 * Handle method results
 */
function handleResult(data) {
    logMessage('Method result: ' + JSON.stringify(data), 'result');
    
    if (data.result) {
        if (data.result.id && data.result.token) {
            // Login successful
            updateStatus('Login successful! User ID: ' + data.result.id, 'success');
            
            // Fetch user data
            fetchUserData(data.result.id);
            
            // Call repairGestixiAssociation
            callRepairGestixiAssociation();
        } else if (data.result.gestixiId || data.result.hashed) {
            // Got QR token data
            handleQRTokenData(data.result);
        }
    }
}

/**
 * Fetch user data
 */
function fetchUserData(userId) {
    updateStatus('Fetching user data...', 'info');
    
    // Subscribe to user data
    sendMessage({
        msg: 'sub',
        name: 'userData',
        params: [userId],
        id: String(messageId++)
    });
    
    // Try to get user method
    sendMessage({
        msg: 'method',
        method: 'users.get',
        params: [userId],
        id: String(messageId++)
    });
}

/**
 * Call repairGestixiAssociation
 */
function callRepairGestixiAssociation() {
    updateStatus('Calling _users.repairGestixiAssociation...', 'info');
    
    sendMessage({
        msg: 'method',
        method: '_users.repairGestixiAssociation',
        params: [{}],
        id: String(messageId++)
    });
}

/**
 * Handle user data
 */
function handleUserData(fields) {
    userData = fields;
    updateStatus('Received user data', 'success');
    
    // Display user profile
    document.getElementById('fetchedData').style.display = 'block';
    document.getElementById('userProfile').textContent = JSON.stringify(fields, null, 2);
    
    let gestixiId = null;
    let hashedToken = null;
    
    // Extract gestixiId - try multiple locations
    if (fields.profile && fields.profile.gestixiIds && fields.profile.gestixiIds.length > 0) {
        gestixiId = fields.profile.gestixiIds[0];
        updateExtractedValue('gestixiId', gestixiId);
        updateExtractedValue('gestixiIds (all)', fields.profile.gestixiIds.join(', '));
    }
    
    // Extract QR tokens - handle different structures
    if (fields.qrCodeTokens) {
        if (fields.qrCodeTokens.arkose) {
            hashedToken = fields.qrCodeTokens.arkose.hashed;
            updateExtractedValue('hashed (from arkose)', hashedToken);
            
            // Also check for gestixiId in token if present
            if (fields.qrCodeTokens.arkose.gestixiId) {
                gestixiId = fields.qrCodeTokens.arkose.gestixiId;
                updateExtractedValue('gestixiId (from token)', gestixiId);
            }
        } 
        // Check if it's an array
        else if (Array.isArray(fields.qrCodeTokens) && fields.qrCodeTokens.length > 0) {
            handleQRTokenData(fields.qrCodeTokens[0]);
            return;
        }
        // Check if it has hashed directly
        else if (fields.qrCodeTokens.hashed) {
            hashedToken = fields.qrCodeTokens.hashed;
            updateExtractedValue('hashed', hashedToken);
        }
    }
    
    // Start QR generation if we have both values
    if (gestixiId && hashedToken) {
        logMessage(`Found data - gestixiId: ${gestixiId}, hashed: ${hashedToken}`, 'success');
        startQRGeneration(gestixiId, hashedToken);
        
        // Auto-disconnect after successful data fetch
        setTimeout(() => {
            updateStatus('Data fetched successfully, disconnecting...', 'success');
            if (ws) {
                ws.close();
            }
        }, 2000);
    } else {
        updateStatus('Missing required data. Calling repairGestixiAssociation...', 'warning');
        callRepairGestixiAssociation();
    }
}

/**
 * Handle QR token data
 */
function handleQRTokenData(tokenData) {
    qrTokenData = tokenData;
    updateStatus('Received QR token data', 'success');
    
    // Extract values
    if (tokenData.gestixiId) {
        updateExtractedValue('gestixiId', tokenData.gestixiId);
    }
    if (tokenData.hashed) {
        updateExtractedValue('hashed', tokenData.hashed);
    }
    if (tokenData.expirationDate) {
        updateExtractedValue('expirationDate', tokenData.expirationDate);
    }
    if (tokenData.receivedAt) {
        updateExtractedValue('receivedAt', new Date(tokenData.receivedAt).toISOString());
    }
    
    // Start QR generation if we have the required data
    if (tokenData.gestixiId && tokenData.hashed) {
        startQRGeneration(tokenData.gestixiId, tokenData.hashed);
    }
}

/**
 * Update extracted value display
 */
function updateExtractedValue(key, value) {
    const container = document.getElementById('extractedValues');
    let elem = document.getElementById('extracted-' + key);
    
    if (!elem) {
        elem = document.createElement('div');
        elem.id = 'extracted-' + key;
        elem.className = 'extracted-item';
        container.appendChild(elem);
    }
    
    elem.innerHTML = `<strong>${key}:</strong> <span class="value">${value}</span>`;
}

/**
 * Start QR code generation
 */
function startQRGeneration(gestixiId, hashedToken) {
    updateStatus('Generating QR codes...', 'success');
    
    // Clear previous extracted values and show only what's being used
    document.getElementById('extractedValues').innerHTML = '';
    updateExtractedValue('gestixiId', gestixiId);
    updateExtractedValue('hashed', hashedToken);
    updateExtractedValue('Magic Key (constant)', 'paH3tGeqmugkUT5Ls');
    updateExtractedValue('Refresh Interval', '10 seconds');
    updateExtractedValue('Algorithm', 'SHA256(magic + hashed + timeBucket + magic)');
    
    // Create generator
    generator = new QRGenerator(String(gestixiId), hashedToken);
    
    // Show QR section
    document.getElementById('qrSection').style.display = 'block';
    
    // Generate initial QR code
    updateQRCode();
    
    // Set up auto-update
    setupAutoUpdate();
}

/**
 * Update QR code display
 */
function updateQRCode() {
    if (!generator) return;
    
    const timestamp = Date.now();
    const result = generator.generateQRCode('current', timestamp);
    
    // Clear and create new QR code
    const qrContainer = document.getElementById('qrContainer');
    if (qrCodeInstance) {
        qrContainer.innerHTML = '';
        qrCodeInstance = null;
    }
    
    qrCodeInstance = new QRCode(qrContainer, {
        text: result.qrCode,
        width: 300,
        height: 300,
        colorDark: '#000000',
        colorLight: '#FFFFFF',
        correctLevel: QRCode.CorrectLevel.H
    });
    
    // Update displays
    document.getElementById('qrString').textContent = result.qrCode;
    document.getElementById('timeBucket').textContent = result.timeBucket;
    document.getElementById('hashInput').textContent = result.hashInput;
    document.getElementById('sha256Hash').textContent = result.hash;
    document.getElementById('generatedAt').textContent = result.generatedAt.toLocaleTimeString();
    
    // Don't log every update - already logged in generateQRCode when bucket changes
    
    return result;
}

/**
 * Set up automatic updates
 */
function setupAutoUpdate() {
    const result = updateQRCode();
    updateCountdown(result.remainingMs);
    
    if (updateInterval) clearInterval(updateInterval);
    if (countdownInterval) clearInterval(countdownInterval);
    
    countdownInterval = setInterval(() => {
        const now = Date.now();
        const currentResult = generator.generateQRCode('current', now);
        updateCountdown(currentResult.remainingMs);
    }, 100);
    
    setTimeout(() => {
        updateQRCode();
        updateInterval = setInterval(() => {
            updateQRCode();
        }, generator.intervalMs);
    }, result.remainingMs);
}

/**
 * Update countdown display
 */
function updateCountdown(remainingMs) {
    const seconds = Math.floor(remainingMs / 1000);
    const milliseconds = remainingMs % 1000;
    const display = `${seconds}.${String(Math.floor(milliseconds / 100)).padStart(1, '0')}s`;
    document.getElementById('timeRemaining').textContent = display;
    
    const countdownEl = document.getElementById('timeRemaining');
    if (seconds <= 2) {
        countdownEl.style.color = '#ff4444';
        countdownEl.style.fontWeight = 'bold';
    } else {
        countdownEl.style.color = '#4CAF50';
        countdownEl.style.fontWeight = 'normal';
    }
}

/**
 * Send message via WebSocket
 */
function sendMessage(message) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        const jsonMessage = JSON.stringify(message);
        ws.send(jsonMessage);
        logMessage('Sent: ' + jsonMessage, 'sent');
    } else {
        logMessage('Cannot send message - WebSocket not connected', 'error');
    }
}

/**
 * Update status display
 */
function updateStatus(message, type = 'info') {
    const statusText = document.getElementById('statusText');
    const globalStatus = document.getElementById('globalStatus');
    
    statusText.textContent = message;
    globalStatus.className = 'global-status status-' + type;
}

/**
 * Log WebSocket message
 */
function logMessage(message, type = 'info') {
    const messagesEl = document.getElementById('wsMessages');
    const entry = document.createElement('div');
    entry.className = 'ws-message ws-' + type;
    
    const timestamp = new Date().toLocaleTimeString();
    entry.innerHTML = `<span class="timestamp">[${timestamp}]</span> <span class="message">${escapeHtml(message)}</span>`;
    
    messagesEl.insertBefore(entry, messagesEl.firstChild);
    
    // Keep only last 50 messages
    while (messagesEl.children.length > 50) {
        messagesEl.removeChild(messagesEl.lastChild);
    }
}

/**
 * Escape HTML for display
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Disconnect WebSocket
 */
function disconnect() {
    if (ws) {
        ws.close();
        ws = null;
    }
    
    if (updateInterval) {
        clearInterval(updateInterval);
        updateInterval = null;
    }
    
    if (countdownInterval) {
        clearInterval(countdownInterval);
        countdownInterval = null;
    }
    
    // Reset UI
    document.getElementById('connectBtn').style.display = 'inline-block';
    document.getElementById('disconnectBtn').style.display = 'none';
    document.getElementById('authToken').disabled = false;
    document.getElementById('wsUrl').disabled = false;
    // Keep data visible but stop generating
    
    updateStatus('Disconnected - Data preserved', 'warning');
}

// Add helper to get auth token from page
window.addEventListener('DOMContentLoaded', () => {
    // Add helper text
    const helpText = document.createElement('div');
    helpText.className = 'help-text';
    helpText.innerHTML = `
        <h3>How to get your auth token:</h3>
        <ol>
            <li>Go to <a href="https://plus.arkose.com" target="_blank">plus.arkose.com</a> and login</li>
            <li>Open DevTools Console (F12)</li>
            <li>Try these commands:
                <pre>localStorage.getItem('Meteor.loginToken')
localStorage.getItem('_storedLoginToken')
document.cookie.match(/galaxy-sticky=([^;]+)/)?.[1]</pre>
            </li>
            <li>Or check Network tab for WebSocket messages with 'token' field</li>
        </ol>
    `;
    document.querySelector('.input-section').appendChild(helpText);
});
