import React, { useState, useRef, useEffect } from 'react';
import { Mic, MicOff, Download, ChevronRight, Check, Zap, Loader } from 'lucide-react';

// The structure of a question object from the backend will be: { type: string, text: string }

const API_BASE_URL = 'http://localhost:5000/api';

// Utility function to convert File object to Base64 string for API transmission
const fileToBase64 = (file) => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // We split to only get the Base64 data part (after the comma in the data URL)
    reader.onload = () => resolve(reader.result.split(',')[1]); 
    reader.onerror = (error) => reject(error);
    reader.readAsDataURL(file);
  });
};

function App() {
  const [stage, setStage] = useState('setup'); // Start at setup stage
  const [questions, setQuestions] = useState([]);
  const [jobTitle, setJobTitle] = useState('Python Developer');
  const [jobDescription, setJobDescription] = useState('We are seeking a Senior Python Developer to join our growing team. The ideal candidate will have 5+ years of experience with Python, Django, and REST API development.');
  const [difficulty, setDifficulty] = useState('easy');
  const [currentQuestion, setCurrentQuestion] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [transcriptions, setTranscriptions] = useState({});
  const [isProcessing, setIsProcessing] = useState(false);
  const [isLoadingQuestions, setIsLoadingQuestions] = useState(false);
  const [sessionId] = useState(() => `session_${Date.now()}`);
  
  // NEW STATES for File Uploads
  const [jobFile, setJobFile] = useState(null);
  const [cvFile, setCvFile] = useState(null);
  const [jobFileName, setJobFileName] = useState('');
  const [cvFileName, setCvFileName] = useState('');
  
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const streamRef = useRef(null);

  // Helper function to handle custom modal messages instead of alert()
  const showMessage = (message, isError = false) => {
    // In a production environment, you would use a custom modal component here.
    console.error(isError ? `ERROR: ${message}` : `MESSAGE: ${message}`);
    alert(message);
  };

  const analyzeJobAndGenerateQuestions = async () => {
    // UPDATED VALIDATION: Require Job Title and at least one source for Job Description
    const hasJobDescriptionText = jobDescription.trim().length > 0;
    
    if (!jobTitle) {
        showMessage("Please provide a Job Profile/Title.", true);
        return;
    }
    if (!hasJobDescriptionText && !jobFile) {
        showMessage("Please provide the Job Description either via text or by uploading a file (PDF/DOCX).", true);
        return;
    }

    setIsLoadingQuestions(true);
    setStage('loading'); 

    try {
        let jobFileBase64 = null;
        let cvFileBase64 = null;

        // Convert files to Base64 if they exist
        if (jobFile) {
            jobFileBase64 = await fileToBase64(jobFile);
        }
        if (cvFile) {
            cvFileBase64 = await fileToBase64(cvFile);
        }

        // 1. Fetch dynamically generated questions from the Flask backend
        const payload = {
            job_title: jobTitle,
            // Send the text content, even if a file is uploaded (can be supplementary)
            job_description: jobFile ? '' : jobDescription, 
            difficulty: difficulty,
            num_questions: 10,
            
            // New file fields sent as Base64 encoded strings
            job_file_data: jobFileBase64,
            job_file_name: jobFileName,
            cv_file_data: cvFileBase64,
            cv_file_name: cvFileName,
        };

        const questionResponse = await fetch(`${API_BASE_URL}/generate_questions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const data = await questionResponse.json();

        if (!questionResponse.ok) {
            showMessage(`Error generating questions: ${data.error}`, true);
            setStage('setup');
            return;
        }

        if (!data.questions || data.questions.length === 0) {
            showMessage("AI could not generate questions. Please try again or simplify the job description.", true);
            setStage('setup');
            return;
        }

        setQuestions(data.questions);

        // 2. Request microphone permission
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        streamRef.current = stream;
        
        // 3. Start interview
        setStage('interview');

    } catch (error) {
        showMessage(`An error occurred: ${error.message}. Check your Flask server and network connection.`, true);
        setStage('setup');
    } finally {
        setIsLoadingQuestions(false);
    }
  };

  const startRecording = async () => {
    if (!streamRef.current) {
      showMessage('Microphone not available. Please refresh and try again.', true);
      return;
    }

    // Ensure previous recording tracks are cleared
    audioChunksRef.current = [];
    const mediaRecorder = new MediaRecorder(streamRef.current, { mimeType: 'audio/webm' }); // Use webm for wider browser support

    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunksRef.current.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      // Use webm type, conversion to WAV will happen on the backend
      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' }); 
      await transcribeAudio(audioBlob);
    };

    mediaRecorder.onerror = (event) => {
        showMessage(`Recorder error: ${event.error.name}`, true);
        setIsRecording(false);
        setIsProcessing(false);
    }

    mediaRecorder.start();
    setIsRecording(true);
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const transcribeAudio = async (audioBlob) => {
    setIsProcessing(true);
    const formData = new FormData();
    formData.append('audio', audioBlob, 'recording.webm');
    formData.append('question_number', currentQuestion.toString());
    formData.append('session_id', sessionId);
    formData.append('question_text', questions[currentQuestion].text);
    formData.append('question_type', questions[currentQuestion].type);

    try {
      const response = await fetch(`${API_BASE_URL}/transcribe`, {
        method: 'POST',
        body: formData,
      });

      const data = await response.json();
      
      if (response.ok) {
        setTranscriptions(prev => ({
          ...prev,
          [currentQuestion]: {
            transcription: data.transcription,
            // Optionally store question details here for easier export later
            question: questions[currentQuestion].text, 
            type: questions[currentQuestion].type
          }
        }));
      } else {
        showMessage(`Transcription Error: ${data.error}`, true);
      }
    } catch (error) {
      showMessage(`Network error during transcription: ${error.message}`, true);
    } finally {
      setIsProcessing(false);
    }
  };

  const nextQuestion = () => {
    if (currentQuestion < questions.length - 1) {
      setCurrentQuestion(prev => prev + 1);
    } else {
      completeInterview();
    }
  };

  const completeInterview = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    setStage('complete');
  };

  const exportSession = async () => {
    try {
      // We will export the session data directly from the frontend state
      // since the backend only stores raw transcription data
      const exportData = questions.map((q, idx) => ({
        question_number: idx,
        question_type: q.type,
        question_text: q.text,
        response: transcriptions[idx]?.transcription || 'No response recorded'
      }));

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `interview_${sessionId}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      showMessage(`Export error: ${error.message}`, true);
    }
  };

  useEffect(() => {
    // Cleanup stream on component unmount
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // --- STAGE: SETUP (Collect Job Details) ---
  if (stage === 'setup') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-purple-600 via-purple-700 to-indigo-800">
        <div className="bg-white rounded-3xl shadow-2xl p-10 md:p-14 max-w-2xl w-full">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-24 h-24 bg-gradient-to-br from-purple-500 to-indigo-600 rounded-full mb-6 shadow-lg">
              <Zap className="w-12 h-12 text-white" />
            </div>
            <h1 className="text-4xl font-bold text-gray-900 mb-4 leading-tight">
              AI Interview Coach Setup
            </h1>
            <p className="text-lg text-gray-600 leading-relaxed">
              Tell us about the job and upload your CV for the most accurate simulation.
            </p>
          </div>
          
          <div className="space-y-6">
            <div>
              <label className="block text-gray-700 font-semibold mb-2" htmlFor="jobTitle">
                Job Profile/Title
              </label>
              <input
                id="jobTitle"
                type="text"
                value={jobTitle}
                onChange={(e) => setJobTitle(e.target.value)}
                placeholder="e.g., Senior Python Developer"
                className="w-full p-4 border border-gray-300 rounded-xl focus:ring-purple-500 focus:border-purple-500 transition duration-150"
              />
            </div>

            {/* UPDATED: Job Description Input Group with Text/File Option */}
            <div>
              <label className="block text-gray-700 font-semibold mb-2" htmlFor="jobDescription">
                Job Description <span className='text-sm text-gray-500'>(Text Input OR File Upload)</span>
              </label>
              <textarea
                id="jobDescription"
                rows="4"
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                placeholder="Paste the job requirements here..."
                disabled={!!jobFile} // Disable text input if file is selected
                className="w-full p-4 border border-gray-300 rounded-xl focus:ring-purple-500 focus:border-purple-500 transition duration-150 resize-none disabled:bg-gray-100"
              ></textarea>
              
              <div className="flex items-center space-x-2 my-2 text-sm text-gray-500">
                <hr className="flex-grow border-gray-300" />
                <span>OR</span>
                <hr className="flex-grow border-gray-300" />
              </div>

              {/* File Input for Job Description */}
              <div className={`flex items-center justify-between p-3 border-2 border-dashed rounded-xl transition duration-150 ${jobFileName ? 'border-purple-500 bg-purple-50' : 'border-gray-300 hover:border-purple-500'}`}>
                <input
                    id="jobFile"
                    type="file"
                    accept=".pdf,.doc,.docx"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files[0];
                        if (file) {
                            setJobFile(file);
                            setJobFileName(file.name);
                            setJobDescription(''); // Clear text input when file is selected
                        } else {
                            setJobFile(null);
                            setJobFileName('');
                        }
                    }}
                />
                <label htmlFor="jobFile" className="cursor-pointer text-purple-600 font-medium hover:text-purple-800 truncate">
                    {jobFileName || 'Upload Job Description (PDF, DOC, or DOCX)'}
                </label>
                {jobFileName && (
                    <button 
                        onClick={() => { setJobFile(null); setJobFileName(''); }} 
                        className="flex-shrink-0 ml-2 text-red-500 hover:text-red-700 font-bold text-xl leading-none"
                    >
                        &times;
                    </button>
                )}
              </div>
            </div>

            {/* NEW: CV Input Group */}
            <div>
              <label className="block text-gray-700 font-semibold mb-2" htmlFor="cvFile">
                Upload CV/Resume <span className='text-sm text-gray-500'>(PDF Recommended - Optional)</span>
              </label>
              <div className={`flex items-center justify-between p-3 border-2 border-dashed rounded-xl transition duration-150 ${cvFileName ? 'border-indigo-500 bg-indigo-50' : 'border-gray-300 hover:border-indigo-500'}`}>
                <input
                    id="cvFile"
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files[0];
                        if (file) {
                            setCvFile(file);
                            setCvFileName(file.name);
                        } else {
                            setCvFile(null);
                            setCvFileName('');
                        }
                    }}
                />
                <label htmlFor="cvFile" className="cursor-pointer text-indigo-600 font-medium hover:text-indigo-800 truncate">
                    {cvFileName || 'Upload CV/Resume (PDF only)'}
                </label>
                {cvFileName && (
                    <button 
                        onClick={() => { setCvFile(null); setCvFileName(''); }} 
                        className="flex-shrink-0 ml-2 text-red-500 hover:text-red-700 font-bold text-xl leading-none"
                    >
                        &times;
                    </button>
                )}
              </div>
            </div>
            {/* END NEW CV Input Group */}


            <div>
              <label className="block text-gray-700 font-semibold mb-2">
                Difficulty Level
              </label>
              <div className="flex space-x-4">
                {['easy', 'medium', 'hard'].map((level) => (
                  <button
                    key={level}
                    onClick={() => setDifficulty(level)}
                    className={`flex-1 py-3 rounded-xl font-bold transition duration-200 shadow-md ${
                      difficulty === level
                        ? 'bg-purple-600 text-white shadow-purple-400/50'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {level.charAt(0).toUpperCase() + level.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={analyzeJobAndGenerateQuestions}
            disabled={isLoadingQuestions}
            className="mt-10 w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 disabled:from-gray-400 disabled:to-gray-500 disabled:cursor-not-allowed text-white font-bold py-5 px-8 rounded-2xl text-xl transition-all duration-200 shadow-xl hover:shadow-2xl flex items-center justify-center transform hover:scale-105 disabled:transform-none"
          >
            {isLoadingQuestions ? (
                <Loader className="w-6 h-6 mr-3 animate-spin" />
            ) : (
                <Zap className="mr-3 w-6 h-6" />
            )}
            {isLoadingQuestions ? 'Analyzing & Generating Questions...' : 'Analyze Job Description'}
            
          </button>
        </div>
      </div>
    );
  }

  // --- NEW STAGE: LOADING ---
  if (stage === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-purple-600 via-purple-700 to-indigo-800">
        <div className="bg-white rounded-3xl shadow-2xl p-10 md:p-14 max-w-lg w-full text-center">
          <div className="inline-flex items-center justify-center w-24 h-24 bg-gradient-to-br from-indigo-400 to-purple-500 rounded-full mb-6 shadow-xl">
            <Loader className="w-12 h-12 text-white animate-spin" />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-3">
            Analyzing Job & Generating Questions...
          </h1>
          <p className="text-lg text-gray-600">
            This may take a moment. We're using AI to tailor the interview to your specific job description, difficulty, and **CV**.
          </p>
        </div>
      </div>
    );
  }


  // --- STAGE: INTERVIEW (Question/Answer recording) ---
  if (stage === 'interview') {
    if (questions.length === 0) return <div>Error: No questions loaded. Go back to setup.</div>;

    const currentQ = questions[currentQuestion];
    const hasTranscription = transcriptions[currentQuestion];
    const isLastQuestion = currentQuestion === questions.length - 1;

    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-purple-600 via-purple-700 to-indigo-800">
        <div className="bg-white rounded-3xl shadow-2xl p-10 md:p-14 max-w-4xl w-full">
          <div className="mb-10">
            <div className="flex items-center justify-between mb-6">
              <div className="flex items-center space-x-3">
                <span className="text-sm font-bold text-purple-700 bg-purple-100 px-4 py-2 rounded-full">
                  Question {currentQuestion + 1} of {questions.length}
                </span>
                <span className={`text-sm font-bold px-4 py-2 rounded-full capitalize ${
                    currentQ.type === 'Technical' ? 'bg-indigo-100 text-indigo-700' :
                    currentQ.type === 'Behavioral' ? 'bg-green-100 text-green-700' :
                    'bg-yellow-100 text-yellow-700'
                }`}>
                    {currentQ.type}
                </span>
              </div>
              <div className="flex gap-2">
                {questions.map((_, idx) => (
                  <div
                    key={idx}
                    className={`h-2.5 w-10 rounded-full transition-all duration-300 ${
                      idx === currentQuestion
                        ? 'bg-purple-600 scale-110'
                        : idx < currentQuestion
                        ? 'bg-purple-400'
                        : 'bg-gray-300'
                    }`}
                  />
                ))}
              </div>
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-gray-900 leading-tight">
              {currentQ.text}
            </h2>
          </div>

          <div className="space-y-8">
            <div className="flex justify-center">
              {!isRecording ? (
                <button
                  onClick={startRecording}
                  disabled={isProcessing}
                  className="bg-gradient-to-r from-red-500 to-red-600 hover:from-red-600 hover:to-red-700 disabled:from-gray-400 disabled:to-gray-500 disabled:cursor-not-allowed text-white font-bold py-5 px-10 rounded-2xl text-lg transition-all duration-200 shadow-xl hover:shadow-2xl flex items-center transform hover:scale-105 disabled:transform-none"
                >
                  <Mic className="mr-3 w-6 h-6" />
                  {isProcessing ? 'Processing...' : 'Start Recording'}
                </button>
              ) : (
                <button
                  onClick={stopRecording}
                  className="bg-gradient-to-r from-gray-800 to-gray-900 hover:from-gray-900 hover:to-black text-white font-bold py-5 px-10 rounded-2xl text-lg transition-all duration-200 shadow-xl hover:shadow-2xl flex items-center"
                >
                  <MicOff className="mr-3 w-6 h-6" />
                  Stop Recording
                </button>
              )}
            </div>

            {isRecording && (
              <div className="bg-red-50 border-2 border-red-200 rounded-2xl p-6 text-center">
                <p className="text-red-700 font-bold text-lg flex items-center justify-center">
                  <span className="w-4 h-4 bg-red-600 rounded-full mr-3 animate-pulse"></span>
                  Recording in progress...
                </p>
              </div>
            )}

            {isProcessing && (
              <div className="bg-blue-50 border-2 border-blue-200 rounded-2xl p-6 text-center">
                <div className="flex items-center justify-center space-x-3">
                  <div className="w-3 h-3 bg-blue-600 rounded-full animate-bounce"></div>
                  <div className="w-3 h-3 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0.1s' }}></div>
                  <div className="w-3 h-3 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0.2s' }}></div>
                </div>
                <p className="text-blue-700 font-bold text-lg mt-3">Transcribing your response...</p>
              </div>
            )}

            {hasTranscription && (
              <div className="bg-green-50 border-2 border-green-200 rounded-2xl p-8">
                <h3 className="font-bold text-xl text-gray-900 mb-4 flex items-center">
                  <div className="w-8 h-8 bg-green-500 rounded-full flex items-center justify-center mr-3">
                    <Check className="w-5 h-5 text-white" />
                  </div>
                  Your Response
                </h3>
                <p className="text-gray-800 text-lg leading-relaxed pl-11">
                  "{transcriptions[currentQuestion].transcription}"
                </p>
              </div>
            )}

            {hasTranscription && (
              <div className="flex justify-end pt-4">
                <button
                  onClick={nextQuestion}
                  className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold py-4 px-8 rounded-2xl transition-all duration-200 shadow-xl hover:shadow-2xl flex items-center transform hover:scale-105"
                >
                  {isLastQuestion ? 'Complete Interview' : 'Next Question'}
                  <ChevronRight className="ml-3 w-6 h-6" />
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }


  // --- STAGE: COMPLETE (Review and Export) ---
  if (stage === 'complete') {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-gradient-to-br from-purple-600 via-purple-700 to-indigo-800">
        <div className="bg-white rounded-3xl shadow-2xl p-10 md:p-14 max-w-4xl w-full">
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-24 h-24 bg-gradient-to-br from-green-500 to-emerald-600 rounded-full mb-6 shadow-lg">
              <Check className="w-12 h-12 text-white" />
            </div>
            <h1 className="text-5xl font-bold text-gray-900 mb-4">
              Interview Complete!
            </h1>
            <p className="text-xl text-gray-600 leading-relaxed">
              Great job! You've answered all {questions.length} custom-generated questions.
            </p>
          </div>

          <div className="bg-gray-50 rounded-2xl p-8 mb-10 max-h-96 overflow-y-auto border border-gray-200">
            <h2 className="font-bold text-2xl text-gray-900 mb-6 text-center">Your Responses</h2>
            <div className="space-y-6">
              {questions.map((question, idx) => (
                <div key={idx} className="bg-white rounded-xl p-6 border-2 border-gray-200 hover:border-purple-300 transition-colors">
                  <div className="flex items-start mb-3">
                    <div className="flex-shrink-0 w-8 h-8 bg-purple-500 rounded-full flex items-center justify-center mr-3 mt-1">
                      <span className="text-white font-bold text-sm">{idx + 1}</span>
                    </div>
                    <div>
                        <span className={`text-xs font-bold px-3 py-1 rounded-full uppercase mb-1 inline-block ${
                            question.type === 'Technical' ? 'bg-indigo-100 text-indigo-700' :
                            question.type === 'Behavioral' ? 'bg-green-100 text-green-700' :
                            'bg-yellow-100 text-yellow-700'
                        }`}>
                            {question.type}
                        </span>
                        <p className="font-bold text-gray-900 text-lg leading-tight">
                            {question.text}
                        </p>
                    </div>
                  </div>
                  <p className="text-gray-700 text-base leading-relaxed pl-11 mt-2">
                    "{transcriptions[idx]?.transcription || 'No response recorded'}"
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <button
              onClick={exportSession}
              className="bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-bold py-4 px-8 rounded-2xl transition-all duration-200 shadow-xl hover:shadow-2xl flex items-center justify-center transform hover:scale-105"
            >
              <Download className="mr-3 w-5 h-5" />
              Export Responses
            </button>
            <button
              onClick={() => window.location.reload()}
              className="bg-gradient-to-r from-gray-600 to-gray-700 hover:from-gray-700 hover:to-gray-800 text-white font-bold py-4 px-8 rounded-2xl transition-all duration-200 shadow-xl hover:shadow-2xl transform hover:scale-105"
            >
              Start New Interview
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default App;
