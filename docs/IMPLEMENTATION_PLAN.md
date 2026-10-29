# AI Textbook Studio 구현 준비 계획

작성일: 2026-10-29 · 기준: [PRD v1.0](PRD.md)

이 문서는 구현 착수 시 작성한 설계안이다. 현재 구현·검증 결과와 설계 대비 조정은 [구현 현황](IMPLEMENTATION_STATUS.md)에 기록한다. PRD의 요구사항은 유지하고, 모호한 부분은 아래의 기본안으로 구체화한다. 수치 제한은 초기 제안값이며 실제 PDF로 검증한 뒤 조정한다.

## 1. 저장소와 실행 환경 점검

- 설계 시점의 추적 파일: PRD, README, `.gitignore`, `.env.example`. 당시 구현 코드·패키지·테스트·마이그레이션은 없었다.
- 로컬 환경에서 Python 3.13.7, Node 22.16.0, npm 11.6.0, `uv`, Docker 명령 경로를 확인했다. Docker 데몬 가동 여부와 패키지 호환성은 미검증이다.
- `.env`는 존재하지만 값을 읽지 않았다. `.env`, PDF, DB, `data/` 등은 기존 Git 제외 규칙을 유지한다.
- PRD 15절의 도구 후보 추가는 기존 작업으로 보존한다.
- 서버 의존성은 `uv`, 프론트엔드는 npm으로 관리하고, 착수 시 실제 설치·빌드가 성공한 버전을 잠금 파일에 기록한다. 버전 번호를 추측해 미리 고정하지 않는다.

## 2. MVP 범위와 설계 결정

| 항목 | 구현 기본안 | 이유·조건 |
|---|---|---|
| 기본 구성 | React + TypeScript + Vite / FastAPI / SQLite + SQLAlchemy + Alembic | PRD 유지, 마이그레이션은 첫 스키마부터 관리 |
| PDF UI | `pdfjs-dist` 직접 사용, 한 페이지씩 canvas + text layer 렌더링 | 선택 문구와 페이지 연결을 직접 제어하고 메모리 사용 제한 |
| PDF 서버 처리 | PyMuPDF를 `PdfService` 뒤에 배치 | 텍스트 추출·이미지 렌더링 구현 격리 |
| AI | OpenAI Responses API 어댑터 1개 + 테스트용 가짜 어댑터 | 다중 공급자 UI와 여러 SDK 구현은 후속 작업 |
| 대화 | 책마다 기본 스레드 1개 | DB에는 스레드를 유지하되 생성·전환 UI는 유예 |
| 스캔 PDF | 현재 페이지 이미지 질문을 P0에 포함 | PRD 성공 기준·완료 정의를 우선; P1에는 영역 지정·OCR 확장 |
| OCR·검색 | P1, MVP 의존성에서 제외 | 현재 페이지 질문에는 임베딩과 벡터 DB가 필요하지 않음 |
| 기기 간 재개 | 모든 기기가 같은 상시 실행 서버에 접속 | 브라우저별 저장이나 PDF 동기화로 해결하지 않음 |
| 상태 충돌 | 마지막으로 서버에 도착한 저장을 채택 | 한 번에 한 기기 사용을 전제; 동시 편집은 P2 |
| 배포 | 개발 중 Vite `/api` 프록시, 운영 시 FastAPI가 SPA와 API 제공 | 운영은 동일 origin, 별도 CORS 구성 최소화 |

설정 화면의 P0 범위는 현재 제공자·모델·설정 오류 표시, 응답 스타일, 이미지 첨부 모드다. 제공자·모델 선택은 서버 허용 목록으로 제한한다. API 키 입력·브라우저 저장은 구현하지 않는다.

PyMuPDF는 공식적으로 AGPL과 상용 라이선스를 제공한다. 저장소 라이선스가 아직 없으므로 배포 정책과의 정합성은 PDF 처리 의존성 확정 작업에서 검토한다. 여기서 특정 라이선스 적용 결론을 내리지는 않는다. [공식 안내](https://pymupdf.readthedocs.io/en/latest/about.html#license-and-copyright)

## 3. 모듈과 파일 배치

아래는 생성 예정 구조이며 현재 존재하는 코드가 아니다.

```text
backend/
  pyproject.toml
  uv.lock
  alembic.ini
  migrations/
  app/
    main.py
    config.py
    db.py
    models.py
    schemas.py
    api/{books,reader,chat,settings}.py
    services/{books,pdf,context,chat}.py
    llm/{base,openai,fake}.py
  tests/
frontend/
  package.json
  package-lock.json
  src/
    app/
    api/
    features/library/
    features/reader/
    features/chat/
    features/settings/
  e2e/
data/                         # Git 제외, 실제 데이터는 서버에만 저장
  learning.db
  books/<uuid>/original.pdf
  books/<uuid>/images/
```

요청 검증은 API, 파일·DB 일관성은 서비스, 제공자별 API 스키마는 어댑터가 담당한다. 프론트에는 React Router, 서버 데이터 조회·갱신에는 TanStack Query를 도입하는 안으로 시작한다. 독서 중 선택·줌·스트림 초안은 컴포넌트 상태로 관리하고 전역 상태 라이브러리는 추가하지 않는다.

FastAPI 요청 안에서 무거운 PDF 작업을 이벤트 루프에 직접 실행하지 않는다. PDF 작업은 문서 인스턴스를 공유하지 않는 별도 프로세스 실행 경계에서 처리하고 실행 시간·동시 실행 수를 제한한다. DB는 동기 SQLAlchemy 세션을 요청 또는 짧은 작업 단위로 열며, LLM 네트워크 대기 중 트랜잭션을 유지하지 않는다.

## 4. 영속 데이터와 일관성

| 테이블 | PRD 대비 추가·정의 | 제약·인덱스 |
|---|---|---|
| books | `last_opened_at`, `status: ready/deleting` | UUID PK, 최근 열람일 정렬 인덱스 |
| reading_states | 페이지 내 `scroll_offset`은 0~1 비율로 정의 | book_id PK/FK, page ≥ 1, zoom 범위 검증 |
| chat_threads | 책당 기본 스레드 | MVP에서는 book_id UNIQUE |
| chat_requests | id, book_id, request_id, payload_hash, attempt, status, error_code, started_at, finished_at | UNIQUE(book_id, request_id), 책당 실행 중 요청 최대 1개 |
| messages | request FK, status, context_snapshot, provider/model, usage JSON, error_code | thread_id/created_at/id 정렬 인덱스 |
| app_settings | 단일 사용자 응답 스타일·이미지 기본값·허용 모델 선택 | 단일 행; API 키 저장 제외 |

`messages.role`은 P0에서 user/assistant만 허용한다. 질문과 응답은 같은 chat request에 연결하고, 응답의 `status`는 pending → streaming → completed 또는 failed/interrupted로 전이한다. 실패한 응답도 부분 본문을 남긴다. 시간은 UTC로 저장하고 UI에서 현지 시간으로 표시한다.

`context_snapshot`에는 질문 당시 페이지, 선택 문구, 잘린 페이지 텍스트, 이미지 포함 여부·캐시 키, 컨텍스트 정책 버전을 저장한다. 원본 이미지 base64는 DB에 중복 저장하지 않는다. 과거 질문을 열면 당시 문맥을 확인할 수 있어야 한다.

SQLite는 FK 활성화, WAL, busy timeout을 설정하고 서버 프로세스 1개로 시작한다. FK는 연결마다 활성화해야 한다. DB 파일은 서버 로컬 디스크에 두며 네트워크 공유 폴더를 전제로 하지 않는다. [SQLAlchemy 공식 문서](https://docs.sqlalchemy.org/en/20/dialects/sqlite.html#foreign-key-support)

### 업로드·삭제

1. 업로드는 `UploadFile`로 받고 제한된 청크로 임시 파일에 기록하면서 크기와 SHA-256을 계산한다. multipart 파서·임시 파일 단계에도 전체 요청 크기 상한을 적용해 API 핸들러 진입 전 디스크 사용을 제한한다. [FastAPI 공식 문서](https://fastapi.tiangolo.com/tutorial/request-files/)
2. PDF 서명만으로 유효하다고 판단하지 않는다. 파서 열기, 페이지 수, 암호화 여부도 검사한다. 암호화·손상 PDF는 P0에서 명시적으로 거절한다.
3. 초기 제한은 파일 100 MiB, 2,000페이지, PDF 처리 작업 30초, 동시 처리 1개다. 값은 설정 가능하게 하고 운영 대상 책으로 조정한다.
4. 검증 후 `data/books/<uuid>/original.pdf`로 이동하고 책·독서 상태·기본 스레드를 한 DB 트랜잭션으로 생성한다. 실패 시 파일을 정리한다. 크래시로 남은 임시 파일·미참조 디렉터리는 시작 시 점검한다.
5. 동일 해시 파일은 새 프로젝트로 등록할 수 있다. 중복 알림은 선택적으로 표시하고 조용히 기존 책으로 합치지 않는다.
6. 삭제 확인은 프론트에서 수행하고, 서버는 삭제 중 상태를 기록한 뒤 파일을 제거하고 DB를 cascade 삭제한다. 실패하면 삭제 중 상태로 재시도 가능하게 유지한다. 활성 채팅 중 삭제는 409로 거절한다.
7. 파일 경로는 서버가 UUID로 만들고 data 루트 하위인지 확인한다. `pdf_path` 같은 내부 경로는 API 응답에서 제외한다.

## 5. API 계약 초안

페이지 번호는 외부 API·UI에서 **1부터**, PyMuPDF 접근에서만 0부터 사용한다. 인쇄된 책의 쪽 번호와 PDF 물리 페이지 번호의 매핑은 P1이다. 프로젝트 없음은 404, 잘못된 입력은 422, 크기 초과는 413, 중복 실행·삭제 충돌은 409로 구분한다.

| API | 요청·응답 핵심 |
|---|---|
| GET `/api/health` | liveness, DB 준비 여부; API 키 값이나 외부 LLM 호출 없음 |
| GET `/api/settings` | provider, model, llm_configured, image capability, 응답 스타일·이미지 기본값; 비밀 제외 |
| PUT `/api/settings` | 응답 스타일과 이미지 기본값만 서버에 영속화; 모델은 서버 허용 목록 안에서만 선택 |
| POST `/api/books` | multipart `file`, `title`, optional `author`; 201 + BookSummary |
| GET `/api/books` | 책 요약, page_count, current_page, progress, last_opened_at; cursor 페이지네이션 |
| GET `/api/books/{id}` | 책 요약과 상태; 열기 성공 시 last_opened_at 갱신 |
| GET `/api/books/{id}/pdf` | application/pdf, inline, Range/206/416 지원 |
| DELETE `/api/books/{id}` | 성공 시 204; 삭제 중 프로젝트는 새 읽기·질문 거절 |
| GET/PUT `/api/books/{id}/state` | page, zoom, scroll_offset, updated_at |
| GET `/api/books/{id}/messages` | 최대 50개 기본값, stable cursor, status·당시 문맥·request_id 포함 |
| POST `/api/books/{id}/chat` | 질문 저장 후 SSE; 아래 본문·이벤트 참조 |
| POST `/api/books/{id}/chat/{request_id}/retry` | 실패·중단 요청만 새 attempt로 재실행; 기존 질문·부분 응답 보존 |

PDF 전달은 Starlette `FileResponse`의 Range 지원을 사용하고 실제 설치 버전으로 검증한다. SPA fallback은 `/api/*`와 존재하지 않는 정적 파일 요청을 가로채지 않게 한다. [공식 문서](https://starlette.dev/responses/)

```json
{
  "request_id": "client-generated-uuid",
  "question": "이 수식의 두 번째 등호가 성립하는 이유는?",
  "page": 127,
  "selected_text": "선택한 문구",
  "image_mode": "auto",
  "response_style": "step_by_step"
}
```

`image_mode`는 auto/always/never다. 질문 당시 값을 캡처하므로 읽는 페이지를 나중에 바꿔도 요청 문맥은 바뀌지 않는다. 서버가 원본에서 페이지 텍스트와 이미지를 취득하고, 클라이언트가 보낸 페이지 본문이나 파일 경로를 신뢰하지 않는다. 초기 입력 상한은 질문 8,000자, 선택 문구 12,000자이며 초과 시 조용히 자르지 않고 422를 반환한다.

동일 request_id·동일 payload의 재전송은 LLM을 다시 호출하지 않는다. 이미 존재하면 상태·메시지 ID를 포함한 409 `request_exists`를 반환하고 클라이언트는 이력 API로 복구한다. 같은 키로 다른 payload를 보내면 409 `request_payload_mismatch`다. 명시적 retry는 attempt를 늘리고 새로운 assistant 행을 생성한다.

### SSE 계약과 실패 처리

브라우저는 POST 본문이 필요한 `fetch` + ReadableStream을 사용한다. 청크와 이벤트 경계가 같다고 가정하지 않고 UTF-8·SSE 프레임을 점진 파싱한다.

| 이벤트 | payload 핵심 | 저장 시점 |
|---|---|---|
| accepted | request_id, user_message_id, assistant_message_id, attempt | 질문·빈 응답을 commit한 뒤 전송 |
| context | page, has_text, image_attached, truncated, warnings | 실제 전송 문맥 스냅샷 저장 |
| delta | assistant_message_id, text | UI 즉시 반영; 서버는 일정 간격으로 부분 본문 저장 |
| completed | assistant_message_id, usage | 최종 본문·완료 상태 commit 후 전송 |
| failed | code, retryable, assistant_message_id | 실패·부분 본문 commit 후 전송 |

스트림 시작 전 검증 오류는 일반 JSON 오류다. 시작 후 오류는 HTTP 상태를 바꿀 수 없으므로 failed 이벤트로 전달한다. 원시 제공자 예외·키·본문은 오류 응답에 노출하지 않는다. heartbeat 주석, 전체 요청 timeout, 프록시 버퍼링 비활성화를 포함한다.

초기 저장 간격은 1초 또는 누적 1,000자, 먼저 도달한 시점이다. 클라이언트 연결 종료 시 upstream 요청을 취소하고 가능한 부분을 저장해 interrupted로 전환한다. 서버 재시작 시 남아 있는 pending/streaming도 interrupted로 정리한다. 강제 종료 직전 미저장 구간은 유실될 수 있으며 완료 응답처럼 표시하지 않는다. 스트림 종료 없이 EOF가 오면 UI는 이력을 재조회해 상태를 확인한다. 자동 재과금될 수 있는 LLM 재호출은 하지 않는다.

## 6. PDF 읽기와 상태 복원

- canvas와 text layer는 같은 viewport·회전·줌을 사용한다. PDF.js 본체와 worker는 같은 잠금 버전을 로컬 번들로 공급하고 외부 CDN에 의존하지 않는다. 기본 렌더링 흐름은 [PDF.js 공식 예제](https://mozilla.github.io/pdf.js/examples/)를 따른다.
- P0는 한 페이지 보기와 이전/다음·직접 페이지 입력·줌으로 제한한다. 전체 페이지 동시 렌더링, 썸네일, 연속 스크롤은 후속 작업이다.
- 선택 영역이 현재 PDF text layer 안에 있을 때만 문구를 캡처한다. 페이지 전환 시 선택을 초기화하고 질문 입력란 위에 선택 문구·페이지 칩을 보여 준다.
- page/zoom/scroll 변경 후 500ms debounce로 저장한다. 요청은 순서대로 보내고 대기 중 변경은 최신 상태로 합쳐 동일 탭의 오래된 저장이 나중에 덮어쓰지 않게 한다.
- 저장 성공·저장 중·실패 상태를 표시한다. 실패한 마지막 상태는 명시적 재시도 및 연결 복구 시 저장하고, 프로젝트 전환 전에 저장을 시도한다.
- 복원 순서는 메타데이터·상태 조회 → PDF 로드 → 페이지·줌 렌더링 → 스크롤 비율 적용이다. 복원 완료 전 자동 저장을 막는다.
- visibilitychange의 hidden 전환에서 마지막 저장을 시도하되, 브라우저 강제 종료 직전 저장은 보장하지 않는다. 종료 후 재개는 서버가 확인한 마지막 저장 상태 기준이다.
- 기기마다 화면 높이가 달라지므로 scroll_offset은 페이지 내 가로·세로 위치 중 P0에서는 세로 비율로 정의한다. 가로 위치는 중앙 정렬로 복구한다.

## 7. AI 컨텍스트와 어댑터

`LlmAdapter.stream(ChatContext) -> AsyncIterator[TextDelta | Usage | Done]`를 최소 인터페이스로 둔다. 오류는 서비스가 공통 코드로 변환한다. capability에는 이미지 입력 지원 여부를 포함하고, 제공자 SDK 객체가 API·UI로 새지 않게 한다.

OpenAI 어댑터는 Responses API 스트림을 내부 이벤트로 변환한다. 대화의 원장은 SQLite로 두고 요청마다 필요한 대화만 전송하며 `store=false`를 사용한다. 이는 응답 저장 옵션이며 모든 제공자 로그의 무보존을 뜻하지 않는다. [공식 스트리밍 안내](https://developers.openai.com/api/docs/guides/streaming-responses), [응답 저장 옵션](https://developers.openai.com/api/docs/guides/migrate-to-responses)

컨텍스트 구성 순서:

1. 책의 학습 도우미 지침과 문서가 명령이 아닌 참고 자료라는 지침.
2. 책 제목, PDF 페이지 번호, 질문.
3. 선택 문구와 현재 페이지의 추출 텍스트.
4. 남은 예산 내 최근 완료 대화. 과거 실패·부분 응답은 기본 제외.
5. 모드에 따라 서버가 렌더링한 현재 페이지 이미지.

초기 텍스트 예산은 입력 12,000토큰, 출력 2,000토큰으로 시작하고 모델 한도에 맞춰 줄인다. 모델용 tokenizer가 없는 경우 보수적인 UTF-8 byte 기준 상한을 사용하고 한계 정확도를 명시한다. 지침·질문·선택을 우선 유지하며, 긴 페이지와 과거 대화를 줄였으면 context 이벤트에 표시한다. 한도를 넘는 필수 입력은 사용자에게 축소를 요청한다. 이미지 예산은 텍스트와 별도로 검증한다.

선택 위치에 해당하는 서버 텍스트를 찾을 수 있으면 주변 문단을 우선 유지하고, 다단 편집·깨진 텍스트로 매칭되지 않으면 선택 문구와 잘린 현재 페이지를 별도 자료로 제공한다. 앞뒤 페이지는 MVP 기본 요청에 넣지 않는다.

auto는 정규화된 추출 텍스트가 50자 미만인 페이지에 이미지를 붙이는 초기 휴리스틱이다. 텍스트가 있는 도표·수식 페이지는 사용자가 always로 전환할 수 있다. never 상태에서 텍스트도 없으면 설명 가능한 문맥이 없음을 표시하고 이미지 허용을 안내한다. 이미지 미지원 모델에 조용히 텍스트 질문으로 대체하지 않는다.

이미지는 페이지당 지연 생성하고 책 해시·페이지·렌더 설정·렌더러 버전으로 캐시한다. 초기 최대 긴 변 2,048px, 총 4MP, 인코딩 결과 5 MiB를 적용하고 초과 시 축소한다. 큰 페이지는 픽셀 할당 전에 예상 크기를 검사한다. 이미지 입력 형식은 [OpenAI 공식 문서](https://developers.openai.com/api/docs/guides/images-vision)에 맞춰 어댑터에서 변환한다.

모델은 `LLM_MODEL`로 명시하고 계정의 실제 이미지 입력·스트리밍 지원을 통합 검증한다. API 키·모델 미설정이어도 업로드·독서는 가능하게 하고 질문 시 설정 오류를 표시한다. 사용량 로그에는 request ID, 모델, 토큰 수, 소요 시간, 상태만 기록하며 본문·선택·base64·키는 기록하지 않는다. UI 참조 페이지는 서버가 보낸 페이지 기준이며, 모델의 임의 페이지 인용을 검증된 출처로 승격하지 않는다.

## 8. 설정·개인 데이터 경계

기존 `.env.example`은 보존하고 설정 모듈을 만들 때 아래 항목을 함께 문서화한다. 아직 구현되지 않은 환경변수를 동작하는 설정처럼 추가하지 않는다.

| 설정 | 기본 정책 |
|---|---|
| DATA_DIR / DATABASE_URL | 저장소 루트 기준 절대 경로로 정규화; 현재 예제의 SQLite URL과 호환 |
| LLM_PROVIDER / LLM_MODEL / OPENAI_API_KEY | openai / 모델 명시 / 서버 전용 키 |
| MAX_UPLOAD_BYTES / MAX_PDF_PAGES | 104857600 / 2000 |
| PDF_PROCESS_TIMEOUT_SECONDS | 30 |
| LLM_INPUT_TOKEN_BUDGET / LLM_MAX_OUTPUT_TOKENS | 12000 / 2000 |
| LLM_TIMEOUT_SECONDS | 120 |
| ALLOWED_HOSTS / ALLOWED_ORIGINS | 개발 로컬·운영 실제 주소만 허용 |

앱 기본 bind는 loopback으로 두고 LAN 운영 설정을 별도로 안내한다. CORS만 접근 제어로 취급하지 않고 허용 Host·Origin 검증 및 프록시 구성을 함께 적용한다. P0는 신뢰하는 개인 LAN 사용이며 인터넷 공개·다중 사용자는 범위 밖이다.

첫 질문 전에 현재 페이지 본문·선택 문구와 선택한 이미지가 외부 LLM에 전송됨을 알리고 전송 범위를 질문 입력부에 표시한다. 모델 답변 Markdown은 raw HTML 실행 없이 렌더링한다. PDF의 스크립트·임베디드 실행 동작도 활성화하지 않는다.

`data/` 외에도 SQLite WAL/SHM, 임시 업로드, 이미지 캐시가 Git 제외 대상인지 검사한다. 테스트용 PDF는 직접 생성한 작은 문서만 임시 디렉터리에 만들며 실제 책을 fixture로 커밋하지 않는다. 백업은 서버 정지 후 DB와 책 디렉터리를 함께 복사하는 P0 절차로 시작한다.

## 9. 구현 순서와 단계별 검수

순서는 시간 약속이 아닌 의존성 순서다. 첫 검수 지점을 통과한 뒤 다음 단계로 이동한다.

| 단계 | 구현 단위 | 통과 기준 |
|---|---|---|
| M0 기반 | 패키지 생성·잠금, 설정, 앱 lifespan, DB·Alembic, health, fake LLM, 기본 실행 문서 | 빈 데이터 디렉터리에서 기동·마이그레이션·재시작; 키 없이 독서 기능 사용 가능 |
| M1 도서 | 업로드 검증·목록·메타데이터·Range PDF·삭제, 라이브러리 UI | 직접 만든 PDF 등록·조회·삭제, 손상·암호화·크기 초과 거절, 실패 후 잔여 파일 점검 |
| M2 독서 | canvas/text layer, 페이지·줌·선택, 상태 저장·복원 UI | 실제 브라우저에서 선택 가능; 재시작·다른 화면 크기에서 마지막 저장 위치 복원 |
| M3 대화 | 메시지·요청 모델, context service, fake SSE, 질문·답변 UI | 키 없이 스트림·실패·retry·이력·책 간 격리 검증 |
| M4 실제 AI·스캔 | OpenAI 어댑터, 텍스트·이미지 처리, 비용·타임아웃 표시 | 허용된 테스트 문서의 텍스트·스캔 페이지 각각 질의 성공; 이미지 전송 모드 확인 |
| M5 운영 | SPA 제공, LAN 실행 문서, 정리·복구·백업, 개인 데이터 Git 검사 | 동일 서버에 두 기기 순차 접속해 위치·이력 복원; PRD 검수 시나리오 전체 통과 |

첫 구현 작업은 M0 → M1 → M2로 잡는다. 먼저 “책 등록 → 읽기 → 저장 → 서버 재시작 → 복원”을 검수하고, 그 위에 가짜 스트림과 실제 AI를 차례로 연결한다.

### 필요한 검증

- backend pytest: 실제 임시 SQLite·파일 디렉터리로 업로드/정리/삭제, FK cascade, 페이지 범위, 상태 저장, request_id 중복 방지, 서버 재시작 후 중단 복구를 검증한다.
- 어댑터 계약: fake가 delta 후 실패·지연·취소를 재현한다. 네트워크 청크가 이벤트 중간에 끊기거나 합쳐지는 경우도 검증한다.
- 브라우저 Playwright: 텍스트 선택 → 문맥 칩 → 질문 → 스트림 → 새로고침 후 이력, 책 A/B 격리, 저장 실패·복구를 검증한다.
- 직접 생성한 130페이지 PDF로 PRD의 127쪽 시나리오를 실행한다. 이미지 전용, 회전, 다단 편집 PDF도 포함해 선택·렌더 품질을 수동 확인한다.
- 실제 제공자 통합 검증은 계정 키와 명시한 모델로 별도 실행한다. 기본 CI는 외부 유료 API를 호출하지 않는다.
- frontend typecheck·production build, backend 검사, `git diff --check`, 개인 데이터 제외 검사를 완료 기준에 포함한다.

## 10. 후속 도구 평가와 남은 결정

EmbeddingGemma 2와 GLM-OCR은 PRD의 후보로 유지한다. EmbeddingGemma 2는 답변 생성 모델이 아니라 검색용 임베딩 모델이며, 공식 모델 카드에서 멀티모달 검색 용도를 확인했다. P1에서 페이지·문단 검색 기준선과 비교한다. [Google 공식 모델 카드](https://ai.google.dev/gemma/docs/embeddinggemma/model_card_2)

GLM-OCR은 OCR·문서 파싱 후보로 평가한다. Mac mini에서의 실제 런타임·메모리·수식/표 품질은 아직 검증하지 않았으므로 MVP 설치 의존성으로 넣지 않는다. [공식 저장소](https://github.com/zai-org/GLM-OCR)

| 남은 결정 | 진행 기본안·결정 시점 |
|---|---|
| 저장소 라이선스와 PDF 엔진 | M0 의존성 확정 전 검토; PdfService 경계로 대체 가능하게 유지 |
| 실제 LLM 모델 | M4 전 계정에서 이미지·스트리밍 지원과 비용 확인 후 LLM_MODEL 명시 |
| Mac mini 운영 주소·데이터 디스크·접근 범위 | M5 전 실제 환경에서 설정; 개발은 현재 Mac의 loopback |
| OCR 채택 | M5 이후 한국어·영어·수식·표의 대표 20페이지로 정확도·지연·메모리 비교 |
| 임베딩·검색 채택 | M5 이후 페이지 조회/FTS 기준선 대비 질문별 검색 품질 측정 |

설계 단계에서 검증한 것은 요구사항·저장소·명령 도구 존재·공식 문서다. 이후 설치·실행·테스트 결과는 [구현 현황](IMPLEMENTATION_STATUS.md)을 기준으로 확인한다.
