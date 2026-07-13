# ens-boilerplate template
---

## Prerequisites

Ensure you have the following installed on your system:

- **Node.js**: [Download and install](https://nodejs.org/).
- **npm**: Comes with Node.js. Run `npm -v` to check if it’s installed.

---

## Local Setup

1. **Clone the Repository**:
   ```bash 
   git clone https://github.com/IN010K48924_EYGS/ens-orbis-engine-template.git
   cd ens-orbis-engine-template
   ```

2. **Install Dependencies:**:
    ```bash
    npm install
    ```
3. **Set configurations to overcome proxy issues (cmd):**:
    ```bash
    set NODE_TLS_REJECT_UNAUTHORIZED=0

    npm config set strict-ssl false
    ```
 **Set configurations to overcome proxy issues (powershell):**:
    ```bash
    $env:NODE_TLS_REJECT_UNAUTHORIZED="0";
    ```
    
4. **Running the Application**:
    ```bash
    npm run dev
    ```
5. **Access Swagger**:
    ```bash
    http://localhost:3000/api-docs
    ```
---