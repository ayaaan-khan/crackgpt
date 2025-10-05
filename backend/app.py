API_KEY = "AIzaSyBwPKqnbTuxyC2UPquA81dOz20OWg7Hdvw" 
from flask import Flask, request, jsonify
from flask_cors import CORS
import speech_recognition as sr
import os
from datetime import datetime
import json
import requests
import time
from pydub import AudioSegment
import io
import base64 # Needed to handle Base64 file data from the frontend

app = Flask(__name__)
CORS(app)

# --- GEMINI API CONFIGURATION ---
# IMPORTANT: Leave apiKey as an empty string. The Canvas environment will inject the key at runtime.
GEMINI_MODEL = "gemini-2.5-flash-preview-05-20"
API_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={API_KEY}"

# Create recordings directory if it doesn't exist
RECORDINGS_DIR = 'recordings'
if not os.path.exists(RECORDINGS_DIR):
    os.makedirs(RECORDINGS_DIR)

# Store interview data in memory (for transcription only, questions are now dynamic)
interview_sessions = {}

# Helper to determine MIME type from filename for multimodal upload
def get_mime_type(filename):
    if filename.lower().endswith('.pdf'):
        return 'application/pdf'
    elif filename.lower().endswith(('.doc', '.docx')):
        # While the Gemini API supports text extraction from DOCX, 
        # using application/pdf is typically more reliable for documents.
        # We use a general type here, though for best results, users should upload PDF.
        return 'application/octet-stream' 
    return 'application/octet-stream'

# --- NEW ENDPOINT FOR QUESTION GENERATION ---
@app.route('/api/generate_questions', methods=['POST'])
def generate_questions():
    """Analyzes job description and generates structured interview questions using Gemini."""
    
    # --- FIXED QUESTION COUNT CONFIGURATION ---
    total_questions = 20
    jd_questions_count = 15
    cv_questions_count = 5
    # ----------------------------------------

    # 1. Input Validation and Data Extraction
    try:
        data = request.get_json()
        job_title = data.get('job_title', 'Software Developer')
        job_description_text = data.get('job_description', '') # Text input
        difficulty = data.get('difficulty', 'easy').lower()
        # num_questions is now implicitly 20 and is not read from input
        # num_questions = data.get('num_questions', 10) 

        # File data (Base64 string and filename)
        job_file_data = data.get('job_file_data')
        job_file_name = data.get('job_file_name', '')
        cv_file_data = data.get('cv_file_data')
        cv_file_name = data.get('cv_file_name', '')

    except Exception as e:
        return jsonify({'error': f'Invalid JSON input: {str(e)}'}), 400

    # 2. Construct Gemini API Contents (Multimodal Handling)
    
    # This list holds the parts of the prompt (text and files)
    contents_parts = []
    
    # Add Job Description data (Text or File)
    if job_file_data:
        mime_type = get_mime_type(job_file_name)
        contents_parts.append({
            "inlineData": {
                "mimeType": mime_type,
                "data": job_file_data
            }
        })
        print(f"Added Job Description file ({job_file_name}, {mime_type}) to contents.")
    elif job_description_text:
        contents_parts.append({"text": f"The Job Description is: {job_description_text}"})
    
    # Add CV/Resume data (Optional File)
    if cv_file_data:
        mime_type = get_mime_type(cv_file_name)
        contents_parts.append({
            "inlineData": {
                "mimeType": mime_type,
                "data": cv_file_data
            }
        })
        print(f"Added CV file ({cv_file_name}, {mime_type}) to contents.")

    # Construct the primary text query, instructing the AI on how to use the documents
    user_query = (
        f"Generate a total of {total_questions} interview questions for the role of '{job_title}' with a '{difficulty}' difficulty level. "
        "The questions must be a balanced mix of Technical, Behavioral, and Situational types. "
    )
    
    if job_file_data or job_description_text:
        # Instruction for the 15 JD-based questions - now implicitly referencing requirements
        user_query += f"Specifically, {jd_questions_count} questions should focus on the general requirements, skills, and common scenarios relevant to the job profile itself. "

    if cv_file_data:
        # Instruction for the 5 CV-based questions - uses the requested phrasing
        user_query += f"The remaining {cv_questions_count} questions MUST be highly personalized, based solely on specific projects, skills, or experiences found in your CV, making them relevant to the role."
    
    # The main text prompt is the final part
    contents_parts.append({"text": user_query})


    # 3. Setup Gemini API Payload
    response_schema = {
        "type": "ARRAY",
        "items": {
            "type": "OBJECT",
            "properties": {
                "type": { "type": "STRING", "description": "The category of the question: Technical, Behavioral, or Situational." },
                "text": { "type": "STRING", "description": "The specific interview question generated." }
            },
            "required": ["type", "text"]
        }
    }
    
    system_prompt = (
        "You are an expert AI Interview Coach. Your task is to analyze all provided input (Job Description text/file and CV/Resume file). "
        "Generate a balanced set of interview questions (Technical, Behavioral, Situational) tailored to the user's difficulty level. "
        "Adhere strictly to the requested question distribution ratio: 15 questions based on general job profile and 5 highly personalized questions based on the CV. "
        "Questions must directly connect the user's experience in the CV to the required skills in the Job Description. "
        "You MUST return ONLY a JSON array matching the provided schema. Do not include any introductory or concluding text."
    )
    
    payload = {
        "contents": [{"parts": contents_parts}], # Use the dynamically constructed parts list
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": response_schema
        }
    }

    headers = {'Content-Type': 'application/json'}
    
    # 4. Call Gemini API with Exponential Backoff
    max_retries = 3
    for attempt in range(max_retries):
        try:
            response = requests.post(API_URL, headers=headers, data=json.dumps(payload))
            response.raise_for_status() # Raise HTTPError for bad responses (4xx or 5xx)
            
            result = response.json()
            
            # Extract and parse the JSON string from the response
            candidate = result.get('candidates', [{}])[0]
            json_text = candidate.get('content', {}).get('parts', [{}])[0].get('text', '[]')
            
            # The model returns a string representation of the JSON array, so we parse it.
            questions_list = json.loads(json_text)
            
            # Basic structural validation
            if not isinstance(questions_list, list) or not all('text' in q and 'type' in q for q in questions_list):
                 raise ValueError("Generated response does not match the expected structured format.")

            print(f"Successfully generated {len(questions_list)} questions.")
            return jsonify({'questions': questions_list})

        except requests.exceptions.HTTPError as e:
            error_message = f"HTTP Error {e.response.status_code}: {e.response.text}"
            print(f"Attempt {attempt + 1} failed: {error_message}")
            if attempt < max_retries - 1 and e.response.status_code in [429, 500, 503]:
                time.sleep(2 ** attempt) # Exponential backoff
                continue
            return jsonify({'error': f'Gemini API request failed: {error_message}'}), e.response.status_code
            
        except (json.JSONDecodeError, ValueError) as e:
            print(f"Attempt {attempt + 1} failed due to JSON/Schema error: {e}")
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
                continue
            return jsonify({'error': f'Failed to parse structured response from AI after {max_retries} attempts. Raw output: {json_text}'}), 500
            
        except requests.exceptions.RequestException as e:
            print(f"Attempt {attempt + 1} failed due to Network error: {e}")
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
                continue
            return jsonify({'error': f'Network error communicating with Gemini API: {str(e)}'}), 500
            
    return jsonify({'error': 'Failed to generate questions after multiple retries.'}), 500


# --- EXISTING ENDPOINTS (UPDATED FOR AUDIO CONVERSION) ---
@app.route('/api/transcribe', methods=['POST'])
def transcribe_audio():
    """Handles audio upload, conversion (from webm to wav), transcription, and session storage."""
    try:
        if 'audio' not in request.files:
            return jsonify({'error': 'No audio file provided'}), 400
        
        audio_file = request.files['audio']
        # The frontend now sends the question text and type, but we store it separately in FE state.
        # We only need to ensure the audio transcription works correctly.
        question_number = request.form.get('question_number', '0')
        session_id = request.form.get('session_id', 'default')
        
        # Save original audio file (assuming webm format from React's MediaRecorder)
        timestamp = datetime.now().strftime('%Y%m%d_%H%M%S')
        original_filename = f"q{question_number}_{timestamp}_original.webm"
        original_filepath = os.path.join(RECORDINGS_DIR, original_filename)
        
        # Create a temporary BytesIO object to hold the audio content
        audio_content = io.BytesIO(audio_file.read())
        
        # Convert to WAV format using pydub
        wav_filename = f"q{question_number}_{timestamp}.wav"
        wav_filepath = os.path.join(RECORDINGS_DIR, wav_filename)
        
        try:
            # Load the audio file (pydub auto-detects format like webm/ogg/etc.)
            # Need to seek back to start of audio_content if it was read previously,
            # but since we read directly into io.BytesIO, it should be fine.
            audio_content.seek(0)
            audio = AudioSegment.from_file(audio_content, format='webm') # Explicitly setting format to webm is often safer
            
            # Export as WAV with proper settings for speech recognition (16kHz, mono)
            audio.export(
                wav_filepath,
                format='wav',
                parameters=['-ar', '16000', '-ac', '1']
            )
        except Exception as e:
            print(f"Audio conversion error: {str(e)}")
            return jsonify({'error': f'Audio conversion error. Check if ffprobe/ffmpeg is installed on your system. Details: {str(e)}'}), 500
        
        # Transcribe audio using Google Speech Recognition (works best with 16kHz WAV)
        recognizer = sr.Recognizer()
        
        try:
            with sr.AudioFile(wav_filepath) as source:
                # Adjust for ambient noise
                recognizer.adjust_for_ambient_noise(source, duration=0.5)
                audio_data = recognizer.record(source)
                
                try:
                    text = recognizer.recognize_google(audio_data)
                except sr.UnknownValueError:
                    text = "[Could not understand audio - please speak clearly]"
                except sr.RequestError as e:
                    return jsonify({'error': f'Speech recognition service error: {str(e)}'}), 500
        except Exception as e:
            return jsonify({'error': f'Error reading audio file for transcription: {str(e)}'}), 500
        
        # Store in session (only transcription data)
        if session_id not in interview_sessions:
            interview_sessions[session_id] = []
        
        # Note: We are not storing the question text here as the frontend already has the full list of dynamic questions.
        # This endpoint just returns the transcription text.
        interview_sessions[session_id].append({
            'question_number': question_number,
            'audio_file': wav_filepath,
            'transcription': text,
            'timestamp': timestamp
        })
        
        return jsonify({
            'transcription': text,
            'audio_file': wav_filename
        })
    
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# The /api/session/<session_id> and /api/export/<session_id> are kept but might be less used
# as the frontend now holds the full question and transcription data for export.

@app.route('/api/session/<session_id>', methods=['GET'])
def get_session(session_id):
    if session_id in interview_sessions:
        # Note: This returns the raw transcription data, not the full structured interview session.
        return jsonify(interview_sessions[session_id])
    return jsonify([])

@app.route('/api/export/<session_id>', methods=['GET'])
def export_session(session_id):
    if session_id not in interview_sessions:
        return jsonify({'error': 'Session not found'}), 404
    
    # Exporting the raw transcription data for local storage
    export_filename = f"interview_raw_export_{session_id}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
    export_path = os.path.join(RECORDINGS_DIR, export_filename)
    
    with open(export_path, 'w') as f:
        json.dump(interview_sessions[session_id], f, indent=2)
    
    return jsonify({
        'message': 'Raw session data exported successfully',
        'file': export_filename,
        'data': interview_sessions[session_id]
    })

if __name__ == '__main__':
    # Ensure you have 'pip install flask flask-cors SpeechRecognition pydub requests' 
    # and have 'ffmpeg' installed on your system for pydub to work correctly.
    app.run(debug=True, port=5000)
