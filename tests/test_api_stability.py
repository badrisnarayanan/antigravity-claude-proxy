import requests
import json
import time
import random
import os
import base64
from datetime import datetime
import re

API_URL = "http://47.77.196.94:3001/v1/messages"
API_KEY = "dummy"
OUTPUT_DIR = "tests/imgs"  # Directory to save generated images

TEST_PROMPTS = [
    "生成一张香蕉的画。",
    "描绘一只在太空中漂浮的猫。",
    "画一座被云雾环绕的山顶城堡。",
    "用印象派风格创作一幅城市夜景。",
    "一张未来派汽车在赛道上飞驰的图像。",
    "绘制一只在森林中漫步的鹿。",
    "创作一幅抽象风格的几何图形画作。",
    "画一个在海边看日落的女孩。",
    "描绘一座未来城市的空中花园。",
    "生成一幅水墨画风格的山水图。",
]

HEADERS = {
    "Content-Type": "application/json",
    "x-api-key": API_KEY,
}

GENERATION_CONFIG = {
    "responseModalities": ["IMAGE"],
    "imageConfig": {
        "aspectRatio": "1:1",
        "imageSize": "1K"
    }
}

def sanitize_filename(text):
    """Convert text to a safe filename"""
    # Remove or replace invalid filename characters
    text = re.sub(r'[<>:"/\\|?*]', '_', text)
    # Limit length
    if len(text) > 50:
        text = text[:50]
    return text

def save_image(response_data, prompt, index):
    """Extract and save image from response"""
    try:
        # Parse response
        if isinstance(response_data, str):
            response_json = json.loads(response_data)
        else:
            response_json = response_data
        
        # Extract image from content blocks
        content = response_json.get('content', [])
        saved_files = []
        
        for block in content:
            if block.get('type') == 'image' and block.get('source', {}).get('type') == 'base64':
                source = block['source']
                media_type = source.get('media_type', 'image/png')
                image_data = source.get('data', '')
                
                # Determine file extension from MIME type
                ext_map = {
                    'image/png': 'png',
                    'image/jpeg': 'jpg',
                    'image/jpg': 'jpg',
                    'image/webp': 'webp',
                    'image/gif': 'gif'
                }
                ext = ext_map.get(media_type, 'png')
                
                # Create output directory if it doesn't exist
                os.makedirs(OUTPUT_DIR, exist_ok=True)
                
                # Generate filename: timestamp_index_prompt.ext
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                safe_prompt = sanitize_filename(prompt)
                filename = f"{timestamp}_{index:02d}_{safe_prompt}.{ext}"
                filepath = os.path.join(OUTPUT_DIR, filename)
                
                # Decode base64 and save
                image_bytes = base64.b64decode(image_data)
                with open(filepath, 'wb') as f:
                    f.write(image_bytes)
                
                saved_files.append(filepath)
                print(f"  Saved image: {filepath}")
            
        
        return saved_files
    except Exception as e:
        print(f"  Error saving image: {e}")
        return []

def send_request(prompt, index):
    payload = {
        "model": "gemini-3-pro-image",
        "messages": [
            {
                "role": "user",
                "content": prompt
            }
        ],
        "generationConfig": GENERATION_CONFIG
    }
    
    start_time = time.time()
    try:
        response = requests.post(API_URL, headers=HEADERS, data=json.dumps(payload))
        end_time = time.time()
        duration = end_time - start_time
        
        status_code = response.status_code
        
        if status_code == 200:
            # Try to save image from response
            saved_files = save_image(response.text, prompt, index)
            return {
                "prompt": prompt, 
                "status": "SUCCESS", 
                "time": duration, 
                "status_code": status_code,
                "saved_files": saved_files
            }
        else:
            return {"prompt": prompt, "status": "FAILURE", "time": duration, "status_code": status_code, "error": response.text}
            
    except requests.exceptions.RequestException as e:
        end_time = time.time()
        duration = end_time - start_time
        return {"prompt": prompt, "status": "ERROR", "time": duration, "error": str(e)}

def run_throughput_test():
    print(f"Starting API throughput test for {API_URL}")
    print(f"Sequential mode: {len(TEST_PROMPTS)} requests, waiting for each to complete before starting the next.")
    print("-" * 50)
    
    start_test_time = time.time()
    results = []
    
    # Sequential loop: directly iterate through TEST_PROMPTS
    for i, prompt in enumerate(TEST_PROMPTS):
        result = send_request(prompt, i + 1)
        results.append(result)
        saved_info = ""
        if result.get('saved_files'):
            saved_info = f" - Saved {len(result['saved_files'])} image(s)"
        print(f"Request {i+1}/{len(TEST_PROMPTS)}: Prompt = '{result['prompt']}' - Status: {result['status']} - Time: {result.get('time', 'N/A'):.2f}s - Status Code: {result.get('status_code', 'N/A')}{saved_info}")
        break
        
    end_test_time = time.time()
    total_test_duration = end_test_time - start_test_time
    
    # Calculate requests per minute
    total_requests = len(TEST_PROMPTS)
    requests_per_minute = (total_requests / total_test_duration) * 60
    
    print("\nTest Summary:")
    successful_requests = [r for r in results if r['status'] == 'SUCCESS']
    failed_requests = [r for r in results if r['status'] == 'FAILURE']
    error_requests = [r for r in results if r['status'] == 'ERROR']
    
    total_successful = len(successful_requests)
    total_failed = len(failed_requests)
    total_errors = len(error_requests)
    
    print(f"Total Requests: {total_requests}")
    print(f"Total Duration: {total_test_duration:.2f} seconds")
    print(f"Requests Completed per minute: {requests_per_minute:.2f}")
    print(f"Successful Requests: {total_successful}")
    print(f"Failed Requests (API error): {total_failed}")
    print(f"Errored Requests (Connection error): {total_errors}")
    
    if successful_requests:
        response_times = [r['time'] for r in successful_requests]
        avg_time = sum(response_times) / len(response_times)
        max_time = max(response_times)
        min_time = min(response_times)
        
        print(f"Average Successful Response Time: {avg_time:.2f}s")
        print(f"Maximum Successful Response Time: {max_time:.2f}s")
        print(f"Minimum Successful Response Time: {min_time:.2f}s")
    else:
        print("No successful requests to calculate response times.")
        
    print("-" * 50)

if __name__ == "__main__":
    run_throughput_test()