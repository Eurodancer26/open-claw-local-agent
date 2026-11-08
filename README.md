# Local AI Orchestrator (OpenAI-Compatible Gateway)

Высокопроизводительный локальный AI-оркестратор на базе **Node.js (ES Modules)** и **`node-llama-cpp`**, спроектированный для работы на потребительском железе с полным аппаратным ускорением на дискретной видеокарте.

---

## 🚀 Архитектурные особенности

Проект реализует двухшаговый конвейер **«План $\rightarrow$ Выполнение»** (Plan & Execute), который минимизирует галлюцинации и позволяет эффективно решать комплексные задачи:
1. **Фаза планирования:** Модель анализирует входящий запрос пользователя и декомпозирует его на последовательные шаги в формате структурированного JSON.
2. **Фаза выполнения:** Оркестратор последовательно прогоняет каждый шаг через языковую модель, агрегируя результат в чистый текстовый отчет для клиента.
3. **Изоляция потоков (Worker Threads):** Тяжелые вычисления инференса вынесены в отдельный поток, что исключает блокировку основного Express-сервера.

---

## 💻 Аппаратный стек и окружение

* **Процессор:** AMD Ryzen 5
* **Видеокарта:** Intel Arc A580 (8 ГБ VRAM)
* **Ускорение инференса:** 99 слоев модели полностью разгружены на GPU (Vulkan/SYCL бэкенд через `node-llama-cpp`).
* **Время отклика:** Полный цикл декомпозиции и пошагового выполнения задачи занимает в среднем **3.5 – 6 секунд**.

---

## 🛠 Технологический стек

* **Runtime:** Node.js (ESM)
* **API Gateway:** Express.js (совместимо со стандартом OpenAI API `/v1/chat/completions`)
* **Inference Engine:** `node-llama-cpp`
* **Concurrency:** Node.js `worker_threads`

---

## 📂 Структура проекта

```text
open-claw-local-agent/
├── models/                   # Директория для GGUF-моделей (в гита не попадает)
│   └── qwen2.5-7b-instruct-q4_k_m.gguf
├── src/
│   ├── server.js             # Главный шлюз, маршрутизация и оркестратор плана
│   └── worker.js             # Воркер для изолированного инференса модели на GPU
├── .gitignore                # Игнорируемые файлы и папки
└── package.json              # Зависимости проекта

<!-- ============================================================================ -->

# Local AI Orchestrator (OpenAI-Compatible Gateway)

A high-performance local AI orchestrator built with **Node.js (ES Modules)** and **`node-llama-cpp`**, designed to run on consumer hardware with full hardware acceleration on a dedicated GPU.

---

## 🚀 Architecture Features

The project implements a two-step **"Plan & Execute"** pipeline that minimizes hallucinations and effectively solves complex tasks:
1. **Planning Phase:** The model analyzes the incoming user request and breaks it down into sequential steps formatted as a structured JSON.
2. **Execution Phase:** The orchestrator sequentially passes each step through the language model, aggregating the output into a clean text report for the client.
3. **Thread Isolation (Worker Threads):** Heavy inference computations are offloaded to a separate worker thread, preventing any blocking of the main Express server.

---

## 💻 Hardware Stack & Environment

* **CPU:** AMD Ryzen 5
* **GPU:** Intel Arc A580 (8 GB VRAM)
* **Inference Acceleration:** 99 model layers are fully offloaded to the GPU (Vulkan/SYCL backend via `node-llama-cpp`).
* **Response Time:** A full cycle of task decomposition and step-by-step execution takes roughly **3.5 – 6 seconds**.

---

## 🛠 Tech Stack

* **Runtime:** Node.js (ESM)
* **API Gateway:** Express.js (OpenAI API compatible via `/v1/chat/completions`)
* **Inference Engine:** `node-llama-cpp`
* **Concurrency:** Node.js `worker_threads`

---

## 📂 Project Structure

```text
open-claw-local-agent/
├── models/                   # Directory for GGUF models (excluded from git)
│   └── qwen2.5-7b-instruct-q4_k_m.gguf
├── src/
│   ├── server.js             # Main API gateway, routing, and plan orchestrator
│   └── worker.js             # Worker thread for isolated model inference on GPU
├── .gitignore                # Ignored files and directories
└── package.json              # Project dependencies