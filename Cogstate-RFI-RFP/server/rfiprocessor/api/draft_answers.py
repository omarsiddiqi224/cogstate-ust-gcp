# rfiprocessor/api/draft_answers.py

import os
import uuid
import json
import tempfile
from datetime import datetime
from typing import List

from fastapi import File, UploadFile, Form, HTTPException, BackgroundTasks

from config.config import Config
from rfiprocessor.services.markdown_converter import MarkdownConverter
from rfiprocessor.core.agents.blank_rfi_parser import BlankRfiParserAgent
from rfiprocessor.core.agents.answer_generator import AnswerGeneratorAgent
from rfiprocessor.services.vector_store_service import VectorStoreService
from rfiprocessor.services.llm_provider import get_advanced_llm
from rfiprocessor.services.db_handler import DatabaseHandler
from rfiprocessor.services.file_upload_service import FileUploadService
from rfiprocessor.db.database import get_db_session
from rfiprocessor.db.db_models import Document, IngestionStatus, RfiStatus, RfiDocument, QUESTION_STATUS_PENDING, QUESTION_STATUS_PROCESSING, QUESTION_STATUS_COMPLETED
from rfiprocessor.models.data_models import (
    FileUploadResponse,
    QuestionResponse,
    KnowledgeBaseItem,
    MetaData
)
from rfiprocessor.utils.logger import get_logger

config = Config()
logger = get_logger(__name__)
file_upload_service = FileUploadService()

def ensure_temp_dir():
    """Ensure temp directory exists (only writable location in Cloud Run)."""
    temp_dir = "/tmp"
    return temp_dir

def save_uploaded_file_to_temp(file_content: bytes, original_filename: str) -> str:
    """Save uploaded file to temporary location."""
    temp_dir = ensure_temp_dir()
    
    # Create temporary file with original extension
    file_extension = os.path.splitext(original_filename)[1]
    with tempfile.NamedTemporaryFile(delete=False, suffix=file_extension, dir=temp_dir) as tmp_file:
        tmp_file.write(file_content)
        return tmp_file.name

def cleanup_temp_file(file_path: str):
    """Clean up temporary file."""
    try:
        if os.path.exists(file_path):
            os.unlink(file_path)
            logger.info(f"Cleaned up temp file: {file_path}")
    except Exception as e:
        logger.warning(f"Failed to cleanup temp file {file_path}: {e}")

async def process_draft_answers(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    fileName: str = Form(...),
    fileType: str = Form(...),
    size: int = Form(...),
    user: str = Form(default="test")
):
    """
    Process blank RFI documents using the blank RFI parser for draft answers.
    Modified for Cloud Run compatibility - uses temporary files only.
    """
    logger.info("=== DRAFT ANSWERS PROCESSING STARTED ===")
    logger.info(f"Received draft answers request:")
    logger.info(f"  - fileName: '{fileName}'")
    logger.info(f"  - fileType: '{fileType}'")
    logger.info(f"  - size: {size} bytes")
    logger.info(f"  - user: '{user}'")
    
    temp_file_path = None
    
    try:
        # Validate file using shared service
        file_upload_service.validate_file_size(size)
        file_upload_service.validate_file_extension(
            filename=fileName,
            file_type=fileType,
            content_type=file.content_type
        )
        
        # Generate unique document ID
        document_id = str(uuid.uuid4())
        logger.info(f"Generated document ID: {document_id}")
        
        # Use actual file information
        actual_filename = file.filename or fileName
        actual_file_type = file.content_type or fileType
        actual_size = file.size or size
        
        logger.info(f"Using actual file data:")
        logger.info(f"  - Actual filename: '{actual_filename}'")
        logger.info(f"  - Actual content type: '{actual_file_type}'")
        logger.info(f"  - Actual size: {actual_size} bytes")
        
        # Save file to temporary location (Cloud Run compatible)
        await file.seek(0)
        content = await file.read()
        temp_file_path = save_uploaded_file_to_temp(content, actual_filename)
        logger.info(f"File saved to temporary location: {temp_file_path}")
        
        # Create RfiDocument entry for draft answers
        logger.info("Creating RfiDocument entry for draft answers...")
        db_session_generator = get_db_session()
        db_session = next(db_session_generator)
        try:
            db_handler = DatabaseHandler(db_session)
            
            # Create RfiDocument entry
            rfi_document = RfiDocument(
                title=f"Draft Answers - {actual_filename}",
                source_filename=actual_filename,
                number_of_questions=0,
                status=RfiStatus.IN_PROGRESS,
                progress=0,
                updated_by_user=user
            )
            
            db_session.add(rfi_document)
            db_session.commit()
            db_session.refresh(rfi_document)
            
            logger.info(f"RfiDocument created with ID: {rfi_document.id}")
            
            # Process the document immediately (not in background)
            logger.info("Processing draft answers immediately...")
            await process_draft_answers_background(rfi_document.id, temp_file_path, actual_filename)
            
            # Schedule cleanup of temp file
            if temp_file_path:
                background_tasks.add_task(cleanup_temp_file, temp_file_path)
            
            # Get the processed results directly from database
            logger.info("Getting processed results from database...")
            db_session.refresh(rfi_document)
            
            if rfi_document.payload and rfi_document.payload.get('questions'):
                logger.info("Returning processed results with questions and answers")
                response = create_response_from_processed_data(document_id, actual_filename, rfi_document)
            else:
                logger.error("No processed results found in database")
                raise HTTPException(status_code=500, detail="Processing failed - no results found")
            
            logger.info(f"Draft answers processing completed: {actual_filename}, Document ID: {document_id}")
            logger.info("=== DRAFT ANSWERS PROCESSING COMPLETED ===")
            return response
            
        finally:
            db_session.close()
            
    except Exception as e:
        logger.error(f"Error processing draft answers: {str(e)}", exc_info=True)
        # Clean up temp file on error
        if temp_file_path:
            cleanup_temp_file(temp_file_path)
        raise HTTPException(status_code=500, detail=f"Internal server error: {str(e)}")

async def process_draft_answers_background(rfi_document_id: str, file_path: str, original_filename: str) -> None:
    """
    Background task to process the blank RFI document for draft answers.
    Modified for Cloud Run - uses temporary files and in-memory processing.
    """
    markdown_temp_path = None
    json_temp_path = None
    
    try:
        logger.info(f"=== BACKGROUND DRAFT ANSWERS PROCESSING STARTED ===")
        logger.info(f"Processing RfiDocument ID: {rfi_document_id}")
        
        # Step 1: Convert document to markdown (keep in memory/temp)
        logger.info("Converting document to markdown...")
        converter = MarkdownConverter()
        markdown_content, markdown_path = converter.convert_to_markdown(file_path)
        
        # Keep track of temp markdown file for cleanup
        markdown_temp_path = markdown_path
        logger.info(f"Markdown converted successfully")
        
        # Step 2: Use blank RFI parser to extract questions
        logger.info("Using blank RFI parser to extract questions...")
        llm_instance = get_advanced_llm()
        blank_parser = BlankRfiParserAgent(llm=llm_instance)
        parsed_data = blank_parser.parse(markdown_content)
        
        # Step 3: Save JSON to temp location (for debugging/logging)
        logger.info("Saving parsed JSON to temp location...")
        json_temp_path = save_blank_json_to_temp(parsed_data, original_filename)
        
        # Step 4: Run inference pipeline to find answers
        logger.info("Running inference pipeline to find answers...")
        questions_with_answers = run_inference_for_questions(parsed_data.get("questions", []))
        
        # Step 5: Update database with results
        logger.info("Updating database with results...")
        update_database_with_results(rfi_document_id, parsed_data, questions_with_answers)
        
        logger.info(f"Background draft answers processing completed for RfiDocument ID: {rfi_document_id}")
        logger.info("=== BACKGROUND DRAFT ANSWERS PROCESSING COMPLETED ===")
        
    except Exception as e:
        logger.error(f"Error processing draft answers background: {str(e)}", exc_info=True)
        # Update database with error status
        update_database_with_error(rfi_document_id, str(e))
    
    finally:
        # Clean up temp files
        if markdown_temp_path:
            cleanup_temp_file(markdown_temp_path)
        if json_temp_path:
            cleanup_temp_file(json_temp_path)

def save_blank_json_to_temp(parsed_data: dict, original_filename: str) -> str:
    """Save parsed data to temporary JSON file (for debugging)."""
    try:
        temp_dir = ensure_temp_dir()
        
        # Generate filename based on original file
        base_name = os.path.splitext(original_filename)[0]
        json_filename = f"{base_name}_blank_{uuid.uuid4().hex[:8]}.json"
        json_path = os.path.join(temp_dir, json_filename)
        
        # Save the parsed data
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(parsed_data, f, indent=2, ensure_ascii=False)
        
        logger.info(f"Saved blank RFI JSON to temp: {json_path}")
        return json_path
        
    except Exception as e:
        logger.error(f"Error saving blank JSON to temp: {str(e)}", exc_info=True)
        raise

def run_inference_for_questions(questions: List[dict]) -> List[dict]:
    """Run inference pipeline to find answers for questions from vector store."""
    try:
        logger.info(f"Running inference for {len(questions)} questions...")
        
        # Initialize inference components
        vector_handler = VectorStoreService()
        answer_generator = AnswerGeneratorAgent()
        
        questions_with_answers = []
        
        for i, question_data in enumerate(questions, 1):
            question_text = question_data.get("question", "")
            logger.info(f"Processing question {i}/{len(questions)}: {question_text[:70]}...")
            
            try:
                # Search for similar chunks in vector store
                logger.info(f"Searching vector store for question: {question_text[:100]}...")
                context_chunks = vector_handler.search_similar_chunks(question_text, k=5)
                logger.info(f"Found {len(context_chunks)} context chunks for question {i}")
                
                # Generate answer using the answer generator
                if context_chunks:
                    logger.info(f"Generating answer using {len(context_chunks)} context chunks...")
                    draft_answer = answer_generator.generate_answer(question_text, context_chunks)
                    logger.info(f"Generated answer: {draft_answer[:100]}...")
                else:
                    logger.warning(f"No context chunks found for question {i}")
                    draft_answer = "No relevant information was found in the knowledge base to answer this question."
                
                # Create knowledge base items from context chunks
                kb_items = [
                    {
                        "id": f"kb_{c['metadata'].get('source_document_id', 0)}_{j}",
                        "title": c['metadata'].get('source_filename', 'Unknown'),
                        "category": c['metadata'].get('document_grade', 'General'),
                        "snippet": c['content'][:250] + "..." if len(c['content']) > 250 else c['content'],
                        "fullText": c['content']
                    }
                    for j, c in enumerate(context_chunks)
                ]
                
                # Create question with answer
                question_with_answer = {
                    "id": i,
                    "question": question_text,
                    "response": draft_answer,
                    "status": config.QUESTION_STATUS_DRAFT,
                    "assignedTo": "AI Assistant",
                    "knowledgeBase": kb_items
                }
                
                questions_with_answers.append(question_with_answer)
                logger.info(f"Generated answer for question {i}: {draft_answer[:100]}...")
                
            except Exception as e:
                logger.warning(f"Failed to generate answer for question {i}: {e}")
                # Create question with error response
                question_with_answer = {
                    "id": i,
                    "question": question_text,
                    "response": "",
                    "status": config.QUESTION_STATUS_DRAFT,
                    "assignedTo": "AI Assistant",
                    "knowledgeBase": []
                }
                questions_with_answers.append(question_with_answer)
        
        logger.info(f"Successfully processed {len(questions_with_answers)} questions")
        return questions_with_answers
        
    except Exception as e:
        logger.error(f"Error running inference for questions: {str(e)}", exc_info=True)
        raise

# Keep the existing database update functions unchanged
def create_response_from_processed_data(document_id: str, fileName: str, rfi_document: RfiDocument) -> FileUploadResponse:
    """Create response from already processed draft answers data."""
    try:
        # Extract data from the processed RFI payload
        rfi_data = rfi_document.payload
        
        # Convert questions to QuestionResponse format
        questions = []
        for question_data in rfi_data.get('questions', []):
            question_response = QuestionResponse(
                id=question_data.get('id', 0),
                question=question_data.get('question', ''),
                response=question_data.get('response', ''),
                status=question_data.get('status', QUESTION_STATUS_PENDING),
                assignedTo=question_data.get('assignedTo', 'AI Assistant'),
                knowledgeBase=question_data.get('knowledgeBase', [])
            )
            questions.append(question_response)
        
        # Create metadata from processed data
        meta_data = rfi_data.get('meta_data', {})
        metadata = MetaData(
            source_document_id=rfi_document.id,
            source_filename=fileName,
            document_type="RFI/RFP",
            company_name=meta_data.get('company_name', 'Unknown'),
            domain=meta_data.get('category', 'Unknown'),
            question_type="mixed",
            document_grade="Standard"
        )
        
        # Create title from company name or filename
        title = f"{meta_data.get('company_name', 'Unknown')} RFI"
        if title == "Unknown RFI":
            title = f"{os.path.splitext(fileName)[0]} RFI"
        
        return FileUploadResponse(
            id=document_id,
            title=title,
            success=True,
            fileName=fileName,
            status=RfiStatus.NOT_STARTED.value,
            lastUpdated=rfi_document.updated_at,
            section="All Sections",
            progress=0,
            questions=questions,
            metaData=metadata
        )
        
    except Exception as e:
        logger.error(f"Error creating response from processed data: {str(e)}", exc_info=True)
        # Fallback to processing response
        return create_processing_response(document_id, fileName, rfi_document)

def update_database_with_results(rfi_document_id: str, parsed_data: dict, questions_with_answers: List[dict]) -> None:
    """Update database with the processed results."""
    try:
        db_session_generator = get_db_session()
        db_session = next(db_session_generator)
        try:
            db_handler = DatabaseHandler(db_session)
            
            # Create the final payload structure
            meta_data = parsed_data.get("meta_data", {})
            final_payload = {
                "id": rfi_document_id,
                "title": meta_data.get("company_name", "Draft Answers"),
                "fileName": meta_data.get("source_filename", "Unknown"),
                "status": RfiStatus.IN_PROGRESS.value,
                "lastUpdated": datetime.utcnow().isoformat(),
                "progress": 0,
                "questions": questions_with_answers,
                "meta_data": meta_data
            }
            
            # Update RfiDocument with results
            updates = {
                "payload": final_payload,
                "status": RfiStatus.IN_PROGRESS,
                "progress": 0,
                "number_of_questions": len(questions_with_answers),
                "updated_by_user": "AI Assistant"
            }
            
            db_handler.update_record(rfi_document_id, updates, model_class=RfiDocument)
            logger.info(f"Successfully updated database for RfiDocument ID: {rfi_document_id}")
            
        finally:
            db_session.close()
            
    except Exception as e:
        logger.error(f"Error updating database with results: {str(e)}", exc_info=True)
        raise

def update_database_with_error(rfi_document_id: str, error_message: str) -> None:
    """Update database with error status."""
    try:
        db_session_generator = get_db_session()
        db_session = next(db_session_generator)
        try:
            db_handler = DatabaseHandler(db_session)
            
            updates = {
                "status": RfiStatus.FAILED,
                "payload": {
                    "error": error_message
                }
            }
            
            db_handler.update_record(rfi_document_id, updates, model_class=RfiDocument)
            logger.info(f"Updated database with error for RfiDocument ID: {rfi_document_id}")
            
        finally:
            db_session.close()
            
    except Exception as e:
        logger.error(f"Error updating database with error: {str(e)}", exc_info=True)