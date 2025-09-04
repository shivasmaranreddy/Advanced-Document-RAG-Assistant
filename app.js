
    // --- Web Worker Script ---
    const workerScript = `
        self.importScripts(
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.4.18/mammoth.browser.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.7.1/jszip.min.js',
            'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
        );

        self.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.11.338/pdf.worker.min.js';

        async function parsePdf(file) {
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await self.pdfjsLib.getDocument(arrayBuffer).promise;
            let allText = '';
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                allText += textContent.items.map(item => item.str).join(' ') + '\\n';
            }
            return allText;
        }

        async function parseDocx(file) {
            const arrayBuffer = await file.arrayBuffer();
            return (await self.mammoth.extractRawText({ arrayBuffer })).value;
        }

        async function parsePptx(file) {
            const zip = await self.JSZip.loadAsync(file);
            let allText = '';
            const slideFiles = Object.keys(zip.files).filter(name => name.startsWith('ppt/slides/slide'));
            for (const slideFile of slideFiles) {
                const slideContent = await zip.file(slideFile).async('string');
                const textNodes = slideContent.match(/<a:t>.*?<\\/a:t>/g) || [];
                allText += textNodes.map(node => node.replace(/<a:t>(.*?)<\\/a:t>/, '$1')).join(' ') + '\\n';
            }
            return allText;
        }

        async function parseXlsx(file) {
            const arrayBuffer = await file.arrayBuffer();
            const workbook = self.XLSX.read(arrayBuffer, {type: 'array'});
            let allText = '';
            workbook.SheetNames.forEach(sheetName => {
                const csvText = self.XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
                allText += 'Sheet: ' + sheetName + '\\n' + csvText + '\\n\\n';
            });
            return allText;
        }

        async function parseCsv(file) {
            return await file.text();
        }

        function chunkText(text, fileName) {
            let paragraphs = text.split(/\\n\\s*\\n/);
            if (paragraphs.length <= 1 && (fileName.endsWith('.csv') || fileName.endsWith('.xlsx'))) {
                 const rows = text.split(/\\r?\\n/).filter(row => row.trim() !== '');
                 paragraphs = [];
                 const chunkSize = 10; 
                 for (let i = 0; i < rows.length; i += chunkSize) {
                    paragraphs.push(rows.slice(i, i + chunkSize).join('\\n'));
                 }
            }
            return paragraphs.map(p => p.trim()).filter(p => p.length > 20).map(p => ({
                source: fileName,
                text: p,
                tokens: p.toLowerCase().split(/[\\s,.;:!?()]+/).filter(Boolean)
            }));
        }

        self.onmessage = async (event) => {
            const { file } = event.data;
            try {
                let textContent;
                if (file.type === 'application/pdf') textContent = await parsePdf(file);
                else if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') textContent = await parseDocx(file);
                else if (file.type === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') textContent = await parsePptx(file);
                else if (file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') textContent = await parseXlsx(file);
                else if (file.type === 'text/csv') textContent = await parseCsv(file);
                else throw new Error('Unsupported file type');
                
                const chunks = chunkText(textContent, file.name);
                self.postMessage({ status: 'complete', file, chunks });
            } catch (error) {
                self.postMessage({ status: 'error', file, message: error.message });
            }
        };
    `;
    
    // --- Main Thread ---
    const workerBlob = new Blob([workerScript], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(workerBlob);
    const parsingWorker = new Worker(workerUrl);

    // Main App DOM elements
    const dom = {
        fileInput: document.getElementById('file-input'),
        fileDropZone: document.getElementById('file-drop-zone'),
        questionInput: document.getElementById('question-input'),
        askButton: document.getElementById('ask-button'),
        chatContainer: document.getElementById('chat-container'),
        statusDot: document.getElementById('status-dot'),
        statusText: document.getElementById('status-text'),
        processingInfo: document.getElementById('processing-info'),
        processingText: document.getElementById('processing-text'),
        progressBar: document.getElementById('progress-bar'),
        documentList: document.getElementById('document-list'),
        resetButton: document.getElementById('reset-button'),
    };
    
    // Auth DOM elements
    const authDom = {
        authContainer: document.getElementById('auth-container'),
        appContainer: document.getElementById('app-container'),
        loginForm: document.getElementById('login-form'),
        signupForm: document.getElementById('signup-form'),
        showSignup: document.getElementById('show-signup'),
        showLogin: document.getElementById('show-login'),
        loginButton: document.getElementById('login-button'),
        signupButton: document.getElementById('signup-button'),
        logoutButton: document.getElementById('logout-button'),
        loginEmail: document.getElementById('login-email'),
        loginPassword: document.getElementById('login-password'),
        signupEmail: document.getElementById('signup-email'),
        signupPassword: document.getElementById('signup-password'),
        signupConfirmPassword: document.getElementById('signup-confirm-password'),
        loginError: document.getElementById('login-error'),
        signupError: document.getElementById('signup-error'),
    };

    let state = {
        documents: [], 
        idf: {},
        isReady: false,
    };

    // --- Auth Logic ---
    function showAuthError(form, message) {
        const errorEl = form === 'login' ? authDom.loginError : authDom.signupError;
        errorEl.textContent = message;
        errorEl.classList.remove('hidden');
    }

    function clearAuthErrors() {
        authDom.loginError.classList.add('hidden');
        authDom.signupError.classList.add('hidden');
    }

    function handleSignup() {
        clearAuthErrors();
        const email = authDom.signupEmail.value.trim();
        const password = authDom.signupPassword.value;
        const confirmPassword = authDom.signupConfirmPassword.value;

        if (!email || !password || !confirmPassword) {
            showAuthError('signup', 'All fields are required.');
            return;
        }
        if (password.length < 6) {
             showAuthError('signup', 'Password must be at least 6 characters.');
            return;
        }
        if (password !== confirmPassword) {
            showAuthError('signup', 'Passwords do not match.');
            return;
        }
        if (localStorage.getItem(email)) {
            showAuthError('signup', 'An account with this email already exists.');
            return;
        }
        // In a real app, you would hash the password. This is for demonstration only.
        localStorage.setItem(email, password); 
        sessionStorage.setItem('loggedInUser', email);
        showApp();
    }

    function handleLogin() {
        clearAuthErrors();
        const email = authDom.loginEmail.value.trim();
        const password = authDom.loginPassword.value;
        const storedPassword = localStorage.getItem(email);

        if (storedPassword && storedPassword === password) {
            sessionStorage.setItem('loggedInUser', email);
            showApp();
        } else {
            showAuthError('login', 'Invalid email or password.');
        }
    }

    function handleLogout() {
        sessionStorage.removeItem('loggedInUser');
        authDom.appContainer.classList.add('hidden');
        authDom.authContainer.classList.remove('hidden');
        
        // Reset the application state
        resetApplication();
        
        // Clear all auth input fields
        authDom.loginEmail.value = '';
        authDom.loginPassword.value = '';
        authDom.signupEmail.value = '';
        authDom.signupPassword.value = '';
        authDom.signupConfirmPassword.value = '';

        // Ensure the login form is shown and signup is hidden
        authDom.signupForm.classList.add('hidden');
        authDom.loginForm.classList.remove('hidden');

        // Clear any previous error messages
        clearAuthErrors();
    }

    function showApp() {
        authDom.authContainer.classList.add('hidden');
        authDom.appContainer.classList.remove('hidden');
    }

    function checkLoginStatus() {
        if (sessionStorage.getItem('loggedInUser')) {
            showApp();
        }
    }

    // --- Main App Logic ---
    function resetApplication() {
        state = { documents: [], idf: {}, isReady: false };
        dom.documentList.innerHTML = '';
        dom.chatContainer.innerHTML = `<div class="flex items-start space-x-3"><div class="p-2 bg-slate-800 text-white rounded-full flex-shrink-0"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg></div><div class="bg-white p-3 rounded-lg shadow-sm"><p class="text-sm">System reset. Please upload new documents to begin.</p></div></div>`;
        updateStatus(false, 'No Documents Loaded');
        dom.fileInput.value = '';
    }

    function updateStatus(isReady, text) {
        state.isReady = isReady;
        dom.statusText.textContent = text;
        dom.statusDot.classList.toggle('bg-red-500', !isReady);
        dom.statusDot.classList.toggle('animate-pulse', !isReady);
        dom.statusDot.classList.toggle('bg-green-500', isReady);
        dom.questionInput.disabled = !isReady;
        dom.askButton.disabled = !isReady;
        dom.resetButton.disabled = state.documents.length === 0;
    }

    function displayMessage(message, sender, sources = []) {
        const isScrolledToBottom = dom.chatContainer.scrollHeight - dom.chatContainer.clientHeight <= dom.chatContainer.scrollTop + 50;
        const existingLoader = document.getElementById('loading-indicator');
        if (existingLoader) existingLoader.remove();
        const messageWrapper = document.createElement('div');
        if (sender === 'user') {
            messageWrapper.innerHTML = `<div class="flex items-start space-x-3 justify-end"><div class="bg-blue-600 text-white p-3 rounded-lg shadow-sm max-w-xl"><p class="text-sm">${message}</p></div><div class="p-2 bg-slate-200 text-slate-700 rounded-full flex-shrink-0"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg></div></div>`;
        } else if (sender === 'ai') {
            const sourcesHtml = sources.length > 0 ? `<div class="mt-3 pt-2 border-t border-slate-200"><h4 class="text-xs font-semibold text-slate-500 mb-1">Sources:</h4><div class="flex flex-wrap gap-2">${sources.map(s => `<span class="text-xs bg-slate-200 text-slate-700 px-2 py-0.5 rounded-full">${s}</span>`).join('')}</div></div>` : '';
            messageWrapper.innerHTML = `<div class="flex items-start space-x-3"><div class="p-2 bg-slate-800 text-white rounded-full flex-shrink-0"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg></div><div class="bg-white p-3 rounded-lg shadow-sm max-w-xl"><div class="prose prose-sm">${marked.parse(message)}</div>${sourcesHtml}</div></div>`;
        } else if (sender === 'loading') {
            messageWrapper.id = 'loading-indicator';
            messageWrapper.innerHTML = `<div class="flex items-start space-x-3"><div class="p-2 bg-slate-800 text-white rounded-full flex-shrink-0"><svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" /></svg></div><div class="bg-white p-3 rounded-lg shadow-sm"><div class="flex items-center space-x-2"><div class="w-2 h-2 bg-slate-500 rounded-full animate-pulse" style="animation-delay: 0s;"></div><div class="w-2 h-2 bg-slate-500 rounded-full animate-pulse" style="animation-delay: 0.2s;"></div><div class="w-2 h-2 bg-slate-500 rounded-full animate-pulse" style="animation-delay: 0.4s;"></div></div></div></div>`;
        }
        dom.chatContainer.appendChild(messageWrapper);
        if (isScrolledToBottom) dom.chatContainer.scrollTop = dom.chatContainer.scrollHeight;
    }

    async function handleFiles(files) {
        if (files.length === 0) return;
        dom.processingInfo.classList.remove('hidden');
        dom.fileDropZone.classList.add('hidden');
        updateStatus(false, `Processing ${files.length} file(s)...`);
        let processedCount = 0;
        for (const file of files) parsingWorker.postMessage({ file });
        parsingWorker.onmessage = (event) => {
            const { status, file, chunks, message } = event.data;
            if (status === 'complete') {
                state.documents.push(...chunks);
                const li = document.createElement('li');
                li.className = "flex items-center bg-white p-2 rounded-md shadow-sm";
                li.innerHTML = `<svg class="w-5 h-5 mr-2 text-blue-500 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m.75 12l3 3m0 0l3-3m-3 3v-6m-1.5-9H5.625A2.625 2.625 0 003 5.625v12.75c0 1.447 1.178 2.625 2.625 2.625h12.75c1.447 0 2.625-1.178 2.625-2.625V11.25a9 9 0 00-9-9z" /></svg><span class="truncate" title="${file.name}">${file.name}</span><span class="ml-auto text-xs text-slate-500">${chunks.length} chunks</span>`;
                dom.documentList.appendChild(li);
            } else console.error(`Error processing ${file.name}:`, message);
            processedCount++;
            dom.progressBar.style.width = `${(processedCount / files.length) * 100}%`;
            dom.processingText.textContent = `Processing file ${processedCount} of ${files.length}...`;
            if (processedCount === files.length) {
                buildIndex();
                updateStatus(true, 'Ready to Answer');
                dom.processingInfo.classList.add('hidden');
                dom.fileDropZone.classList.remove('hidden');
                dom.progressBar.style.width = '0%';
            }
        };
    }

    // RAG Core Logic
    function buildIndex() {
        const docCount = state.documents.length;
        const docFrequency = {};
        for (const doc of state.documents) {
            for (const token of new Set(doc.tokens)) {
                docFrequency[token] = (docFrequency[token] || 0) + 1;
            }
        }
        for (const token in docFrequency) {
            state.idf[token] = Math.log(docCount / (1 + docFrequency[token]));
        }
        state.documents.forEach(doc => {
            const tf = {};
            for (const token of doc.tokens) tf[token] = (tf[token] || 0) + 1;
            const vector = {};
            let magnitude = 0;
            for (const token in tf) {
                if (state.idf[token]) {
                    const tfidf = (tf[token] / doc.tokens.length) * state.idf[token];
                    vector[token] = tfidf;
                    magnitude += tfidf * tfidf;
                }
            }
            doc.tfidfVector = vector;
            doc.magnitude = Math.sqrt(magnitude);
        });
    }

    function retrieveContext(question) {
        const queryTokens = question.toLowerCase().split(/[\s,.;:!?()]+/).filter(Boolean);
        const queryTf = {};
        for (const token of queryTokens) queryTf[token] = (queryTf[token] || 0) + 1;
        
        const queryVector = {};
        let queryMagnitude = 0;
        for (const token in queryTf) {
            if (state.idf[token]) {
                const tfidf = (queryTf[token] / queryTokens.length) * state.idf[token];
                queryVector[token] = tfidf;
                queryMagnitude += tfidf * tfidf;
            }
        }
        queryMagnitude = Math.sqrt(queryMagnitude);

        const scoredDocs = state.documents.map(doc => {
            let dotProduct = 0;
            for (const token in queryVector) {
                if (doc.tfidfVector[token]) {
                    dotProduct += queryVector[token] * doc.tfidfVector[token];
                }
            }
            const similarity = (doc.magnitude === 0 || queryMagnitude === 0) ? 0 : dotProduct / (doc.magnitude * queryMagnitude);
            return { ...doc, score: similarity };
        });

        return scoredDocs.filter(doc => doc.score > 0).sort((a, b) => b.score - a.score).slice(0, 5);
    }
    
    async function generateAnswer(context, question) {
        const apiKey = "AIzaSyAGqdh9hVcTkFa7LmGGeYwCc5Gjcych-Yo"; // NOTE: Replace with your actual API key
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${apiKey}`;
        const systemPrompt = "You are a helpful assistant. Answer the user's question based *only* on the provided context. Synthesize information from the different source chunks if necessary. Do not use any external knowledge. If the answer is not found in the context, state that you couldn't find an answer in the provided documents. Format your response using Markdown.";
        const userPrompt = `CONTEXT:\n---\n${context}\n---\n\nQUESTION: ${question}`;
        const payload = { contents: [{ parts: [{ text: userPrompt }] }], systemInstruction: { parts: [{ text: systemPrompt }] } };

        try {
            let response;
            for (let i = 0, delay = 1000; i < 5; i++, delay *= 2) {
                response = await fetch(apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (response.ok) break;
                if (response.status === 429 || response.status >= 500) await new Promise(resolve => setTimeout(resolve, delay));
                else throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }
            if (!response.ok) throw new Error(`API call failed after retries. Status: ${response.status}`);
            const result = await response.json();
            const text = result.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error("No text in API response.");
            return text;
        } catch (error) {
            console.error("Error calling Gemini API:", error);
            return "Sorry, I encountered an error while trying to generate an answer. Please check the console for details.";
        }
    }

    async function askQuestion() {
        const question = dom.questionInput.value.trim();
        if (!question || !state.isReady) return;

        displayMessage(question, 'user');
        dom.questionInput.value = '';
        dom.askButton.disabled = true;
        dom.questionInput.disabled = true;
        displayMessage('', 'loading');

        const relevantChunks = retrieveContext(question);
        
        if (relevantChunks.length === 0) {
            displayMessage("I couldn't find any relevant information in the loaded documents to answer that question.", 'ai');
        } else {
            const contextParts = [];
            const sources = new Set();
            for (const chunk of relevantChunks) {
                contextParts.push(`Source: ${chunk.source}\nContent: ${chunk.text}`);
                sources.add(chunk.source);
            }
            const answer = await generateAnswer(contextParts.join('\n\n---\n\n'), question);
            displayMessage(answer, 'ai', Array.from(sources));
        }
        
        dom.askButton.disabled = false;
        dom.questionInput.disabled = false;
        dom.questionInput.focus();
    }

    // --- Event Listeners & Initialization ---
    function init() {
        // Auth Listeners
        authDom.showSignup.addEventListener('click', (e) => {
            e.preventDefault();
            clearAuthErrors();
            authDom.loginForm.classList.add('hidden');
            authDom.signupForm.classList.remove('hidden');
        });

        authDom.showLogin.addEventListener('click', (e) => {
            e.preventDefault();
            clearAuthErrors();
            authDom.signupForm.classList.add('hidden');
            authDom.loginForm.classList.remove('hidden');
        });
        
        authDom.loginButton.addEventListener('click', handleLogin);
        authDom.signupButton.addEventListener('click', handleSignup);
        authDom.logoutButton.addEventListener('click', handleLogout);

        // Main App Listeners
        dom.fileDropZone.addEventListener('click', () => dom.fileInput.click());
        dom.fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
        ['dragover', 'dragleave', 'drop'].forEach(eventName => {
            dom.fileDropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
                if (eventName === 'dragover') dom.fileDropZone.classList.add('dragover');
                if (eventName === 'dragleave' || eventName === 'drop') dom.fileDropZone.classList.remove('dragover');
                if (eventName === 'drop') handleFiles(e.dataTransfer.files);
            });
        });
        dom.askButton.addEventListener('click', askQuestion);
        dom.questionInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') askQuestion(); });
        dom.resetButton.addEventListener('click', resetApplication);
        
        updateStatus(false, 'No Documents Loaded');
        
        checkLoginStatus(); // Check login status on page load
    }

    init();
